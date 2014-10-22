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
      var error = new Error('Channel hungup.');
      error.name = 'ChannelHungup';
      this.emit('Error', error);
      this.transition('done');
    },

    // removes handler for channel hanging up
    removeHangupHandler: function() {
      if (this.currentHangupHandler) {
        channel.removeListener('StasisEnd', this.currentHangupHandler);
        this.currentHangupHandler = null;
      }
    },

    states : {
      // bootstrapping
      'init' : {
        _onEnter: function() {
          this.currentHangupHandler = this.hangupHandler.bind(this);
          channel.once('StasisEnd', this.currentHangupHandler);
        },

        init: function(domain, mailboxNumber) {
          var self = this;

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
          this.deferUntilTransition('unknownMailbox');
        },

        authenticate: function() {
          this.deferUntilTransition('authenticating');
        }
      },

      // waiting for mailbox number
      'unknownMailbox': {
        _onEnter: function() {
          // TODO: play prompt to inform user that mailbox # is needed
        },

        // set mailbox number
        setMailbox: function(mailboxNumber) {
          var self = this;

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
          this.deferUntilTransition('authenticating');
        }
      },

      // waiting for authentication
      'authenticating' : {
        _onEnter: function() {
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
          // cleanup
          this.removeHangupHandler();
        },

        '*': function() {
          console.error('called handle on spent auth fsm instance.');
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
  var state = fsm(channel, dependencies, skipAuth);

  var api = {
    init: function(domain, mailboxNumber) {
      mailboxNumber = mailboxNumber || '';
      var deferred = Q.defer();

      state.on('AuthenticatorLoaded', onLoaded);
      state.on('Error', onError);

      process.nextTick(function() {
        state.handle('init', domain, mailboxNumber);
      });

      return deferred.promise;

      function onLoaded(mailbox) {
        removeListeners();
        deferred.resolve(mailbox);
      }

      function onError(err) {
        removeListeners();
        deferred.reject(err);
      }

      function removeListeners() {
        state.off('AuthenticatorLoaded', onLoaded);
        state.off('Error', onError);
      }
    },

    setMailbox: function(mailboxNumber) {
      var deferred = Q.defer();

      state.on('AuthenticatorLoaded', onLoaded);
      state.on('Error', onError);

      process.nextTick(function() {
        state.handle('setMailbox', mailboxNumber);
      });

      return deferred.promise;

      function onLoaded(mailbox) {
        removeListeners();
        deferred.resolve(mailbox);
      }

      function onError(err) {
        removeListeners();
        deferred.reject(err);
      }

      function removeListeners() {
        state.off('AuthenticatorLoaded', onLoaded);
        state.off('Error', onError);
      }
    },

    authenticate: function(password) {
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
        removeListeners();
        deferred.resolve();
      }

      function onError(err) {
        removeListeners();
        deferred.reject(err);
      }

      function removeListeners() {
        state.off('Authenticated', onAuthenticated);
        state.off('Error', onError);
      }
    } 
  };
  
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
