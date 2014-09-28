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
 * @param {object} dal - voicemail data access layer
 * @param {object} prompts - an array of prompts
 * @param {object} promptHelper - prompt helper
 * @returns {machina.Fsm} fsm - a finite state machine instance
 */
function fsm(channel, dal, prompts, promptHelper) {
  var fsmInstance = new machina.Fsm({

    initialState: 'init',

    // handler for channel hanging up
    hangupHandler: function(event) {
      this.hungup = true;
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

    // TODO: add prompts
    states : {
      // bootstrapping
      'init' : {
        _onEnter: function() {
          this.currentHangupHandler = this.hangupHandler.bind(this);
          channel.once('StasisEnd', this.currentHangupHandler);
        },

        init: function(domain, mailboxNumber) {
          var self = this;

          dal.context.get(domain)
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
              return dal.mailbox.get(mailboxNumber, self.context);
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
              self.emit('AuthenticatorLoaded', self.context, self.mailbox);
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
        // set mailbox number
        setMailbox: function(mailboxNumber) {
          var self = this;

          dal.mailbox.get(mailboxNumber, this.context)
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
              self.emit('AuthenticatorLoaded', self.context, self.mailbox);
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
        // attempt to authenticate
        authenticate: function(password) {
          if (this.mailbox.password !== password) {
            var err = new Error('Password did not match');
            err.name = 'InvalidPassword';
            this.emit('Error', err);

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
          console.error('called handle on spent fsm instance.');
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
 * @param {object} dal - voicemail data access layer
 * @param {object} prompts - an array of prompts
 * @param {object} promptHelper - prompt helper
 * @returns {object} prompt - a prompt object
 */
function createAuthenticator(channel, dal, prompts, promptHelper) {
  var state = fsm(channel, dal, prompts, promptHelper);

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

      function onLoaded(context, mailbox) {
        removeListeners();
        deferred.resolve([context, mailbox]);
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

      function onLoaded(context, mailbox) {
        removeListeners();
        deferred.resolve([context, mailbox]);
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
        state.handle('authenticate', password);
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
 * @param {object} dal - voicemail data access layer
 * @param {object} prompts - an array of prompts
 * @param {object} promptHelper - helper for creating an playing prompts
 * @returns {object} module - module functions
 */
module.exports = function(dal, prompts, promptHelper) {
  return {
    create: function(channel) {
      return createAuthenticator(channel, dal, prompts, promptHelper);
    }
  };
};
