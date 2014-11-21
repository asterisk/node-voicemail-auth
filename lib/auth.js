/**
 * Authentication module for Asterisk voicemail.
 *
 * @module tests-context
 * @copyright 2014, Digium, Inc.
 * @license Apache License, Version 2.0
 * @author Samuel Fortier-Galarneau <sgalarneau@digium.com>
 */

'use strict';

var Q = require('q');
var machina = require('machina');
var util = require('util');

/**
 * Returns a new finite state machine instance for the given channel and
 * helpers.
 *
 * @param {Channel} channel - a channel instance
 * @param {object} dependencies - object keyed by module dependencies
 * @param {boolean} skipAuth - whether auth should be skipped after mailbox is
 *  loaded 
 * @returns {machina.Fsm} fsm - a finite state machine instance
 */
function fsm(channel, dependencies, skipAuth) {
  var fsmInstance = new machina.Fsm({

    initialState: 'init',

    // handler for channel hanging up
    hangupHandler: function(event) {
      dependencies.logger.trace('hangupHandler called');

      var error = new Error('Channel hungup.');
      error.name = 'ChannelHungup';
      this.emit('Error', error);
      this.transition('done');
    },

    // removes handler for channel hanging up
    removeHangupHandler: function() {
      if (this.currentHangupHandler) {
        dependencies.logger.trace('Removing hangupHandler');

        channel.removeListener('StasisEnd', this.currentHangupHandler);
        this.currentHangupHandler = null;
      }
    },

    states : {
      // bootstrapping
      'init' : {
        _onEnter: function() {
          dependencies.logger.trace('In init state');

          this.currentHangupHandler = this.hangupHandler.bind(this);
          channel.once('StasisEnd', this.currentHangupHandler);
        },

        init: function(domain, mailboxNumber) {
          var self = this;

          dependencies.logger.trace('init called');

          dependencies.dal.context.get(domain)
            .then(function(context) {
              if (!context) {
                var err = new Error(util.format(
                    'Could not find context with domain %s',
                    domain));
                err.name = 'ContextNotFound';
                self.emit('Error', err);
                self.transition('done');

                return;
              }

              self.context = context;
              return dependencies.dal.mailbox.get(mailboxNumber, self.context);
            })
            .then(function(mailbox) {
              if (!mailbox) {
                var err = new Error(util.format(
                    'Could not find mailbox with number %s',
                    mailboxNumber));
                err.name = 'MailboxNotFound';
                self.emit('Error', err);
                self.transition('unknownMailbox');

                return;
              }

              self.mailbox = mailbox;
              self.emit('AuthenticatorLoaded', self.mailbox);
              self.transition('authenticating');
            })
            .catch(function(err) {
              self.emit('Error', err);
              self.transition('done');
            });
        },

        setMailbox: function() {
          dependencies.logger.trace(
              'Deferring setMailbox until unknownMailbox');

          this.deferUntilTransition('unknownMailbox');
        },

        authenticate: function() {
          dependencies.logger.trace(
              'Deferring authenticate until authenticating');

          this.deferUntilTransition('authenticating');
        }
      },

      // waiting for mailbox number
      'unknownMailbox': {
        _onEnter: function() {
          // TODO: play prompt to inform user that mailbox # is needed
          dependencies.logger.trace('In unknownMailbox');
        },

        // set mailbox number
        setMailbox: function(mailboxNumber) {
          var self = this;

          dependencies.logger.trace('setMailbox called');

          dependencies.dal.mailbox.get(mailboxNumber, this.context)
            .then(function(mailbox) {
              if (!mailbox) {
                var err = new Error(util.format(
                    'Could not find mailbox with number %s',
                    mailboxNumber));
                err.name = 'MailboxNotFound';
                self.emit('Error', err);

                return;
              }

              self.mailbox = mailbox;
              self.emit('AuthenticatorLoaded', self.mailbox);
              self.transition('authenticating');
            })
            .catch(function(err) {
              self.emit('Error', err);
              self.transition('done');
            });
        },

        authenticate: function() {
          dependencies.logger.trace(
              'Deferring authenticate until authenticating');

          this.deferUntilTransition('authenticating');
        }
      },

      // waiting for authentication
      'authenticating' : {
        _onEnter: function() {
          dependencies.logger.trace('In authenticating');

          if (skipAuth) {
            this.transition('done');
          } else {
            var sounds = dependencies
              .config
              .getAppConfig()
              .prompts
              .auth
              .password;

            this.currentPrompt = dependencies.prompt.create(sounds, channel);
            this.currentPrompt.play();
          }
        },

        // attempt to authenticate
        authenticate: function(password) {
          dependencies.logger.trace('authenticate called');

          if (this.currentPrompt) {
            this.currentPrompt.stop();
          }

          if (this.mailbox.password !== password) {
            var err = new Error('Password did not match');
            err.name = 'InvalidPassword';
            this.emit('Error', err);

            var sounds = dependencies
              .config
              .getAppConfig()
              .prompts
              .auth
              .invalidPassword;
            this.currentPrompt = dependencies.prompt.create(sounds, channel);
            this.currentPrompt.play();

            return;
          }

          this.emit('Authenticated');
          this.transition('done');
        }
      },

      // done authenticating 
      'done': {
        _onEnter: function() {
          dependencies.logger.trace('In done');

          // cleanup
          this.removeHangupHandler();
        },

        '*': function() {
          dependencies.logger.error('Called handle on spent fsm');
        }
      }
    }
  });

  return fsmInstance;
}

/**
 * Returns an authenticator object that can be used to authenticate a mailbox.
 *
 * @param {Channel} channel - a channel instance
 * @param {object} dependencies - object keyed by module dependencies
 * @param {boolean} skipAuth - whether auth should be skipped after mailbox is
 *  loaded 
 * @returns {object} api - api for authenticating a mailbox
 */
function createAuthenticator(channel, dependencies, skipAuth) {
  dependencies.logger = dependencies.logger.child({
    component: 'voicemail-auth'
  });

  var state = fsm(channel, dependencies, skipAuth);

  var api = {
    init: function(domain, mailboxNumber) {
      dependencies.logger.trace('init called');

      mailboxNumber = mailboxNumber || '';
      var deferred = Q.defer();

      state.on('AuthenticatorLoaded', onLoaded);
      state.on('Error', onError);

      process.nextTick(function() {
        state.handle('init', domain, mailboxNumber);
      });

      return deferred.promise;

      function onLoaded(mailbox) {
        dependencies.logger.trace('Received AuthenticatorLoaded from fsm');

        removeListeners();
        deferred.resolve(mailbox);
      }

      function onError(err) {
        dependencies.logger.trace('Received Error from fsm');

        removeListeners();
        deferred.reject(err);
      }

      function removeListeners() {
        dependencies.logger.trace('Removing fsm event handlers');

        state.off('AuthenticatorLoaded', onLoaded);
        state.off('Error', onError);
      }
    },

    setMailbox: function(mailboxNumber) {
      dependencies.logger.trace('setMailbox called');

      var deferred = Q.defer();

      state.on('AuthenticatorLoaded', onLoaded);
      state.on('Error', onError);

      process.nextTick(function() {
        state.handle('setMailbox', mailboxNumber);
      });

      return deferred.promise;

      function onLoaded(mailbox) {
        dependencies.logger.trace('Received AuthenticatorLoaded from fsm');

        removeListeners();
        deferred.resolve(mailbox);
      }

      function onError(err) {
        dependencies.logger.trace('Received Error from fsm');

        removeListeners();
        deferred.reject(err);
      }

      function removeListeners() {
        dependencies.logger.trace('Removing fsm event handlers');

        state.off('AuthenticatorLoaded', onLoaded);
        state.off('Error', onError);
      }
    },

    authenticate: function(password) {
      dependencies.logger.trace('authenticate called');

      var deferred = Q.defer();

      state.on('Authenticated', onAuthenticated);
      state.on('Error', onError);

      process.nextTick(function() {
        if (skipAuth) {
          onAuthenticated();
        } else {
          state.handle('authenticate', password);
        }
      });

      return deferred.promise;

      function onAuthenticated() {
        dependencies.logger.trace('Received Authenticated from fsm');

        removeListeners();
        deferred.resolve();
      }

      function onError(err) {
        dependencies.logger.trace('Received Error from fsm');

        removeListeners();
        deferred.reject(err);
      }

      function removeListeners() {
        dependencies.logger.trace('Removing fsm event handlers');

        state.off('Authenticated', onAuthenticated);
        state.off('Error', onError);
      }
    } 
  };
  
  dependencies.logger.info({
    skipAuth: skipAuth
  }, 'Voicemail authenticator created');

  return api;
}

/**
 * Returns module functions.
 *
 * @param {object} dependencies - object keyed by module dependencies
 * @param {boolean} skipAuth - whether auth should be skipped after mailbox is
 *  loaded 
 * @returns {object} module - module functions
 */
module.exports = function(dependencies) {
  return {
    create: function(channel, skipAuth) {
      return createAuthenticator(channel, dependencies, skipAuth);
    }
  };
};
