/**
 * Prompt module unit tests.
 *
 * @module tests-context
 * @copyright 2014, Digium, Inc.
 * @license Apache License, Version 2.0
 * @author Samuel Fortier-Galarneau <sgalarneau@digium.com>
 */

'use strict';

/*global describe:false*/
/*global before:false*/
/*global it:false*/

var Q = require('q');
var assert = require('assert');
var EventEmitter = require('events').EventEmitter;

// milliseconds to delay async ops for mock requests
var asyncDelay = 100;

/**
 * Returns a mock data access layer.
 */
var getMockDal = function() {

  var dal = {
    context: {
      get: function(domain) {
        var deferred = Q.defer();

        // mock not find context
        if (domain === '') {
          deferred.resolve();
        } else {
          setTimeout(function() {
            deferred.resolve({
              domain: domain
            });
          }, asyncDelay);
        }

        return deferred.promise;
      }
    },
    
    mailbox: {
      get: function(number, context) {
        var deferred = Q.defer();

        // mock not find mailbox
        if (number === '') {
          deferred.resolve();
        } else {
          setTimeout(function() {
            deferred.resolve({
              mailboxNumber: number,
              password: 'mypassword',
              getContext: function() {return context;}
            });
          }, asyncDelay);
        }

        return deferred.promise;
      }
    }
  };

  return dal;
};

var getMockChannel = function() {
  return new EventEmitter();
};

var auth;

describe('auth', function() {

  before(function(done) {
    var dal = getMockDal();
    auth = require('../lib/auth.js')({dal: dal});

    done();
  });

  it('should support creating and initializing authenticator', function(done) {
    var channel = getMockChannel();
    var authenticator = auth.create(channel);
    var domain = 'mydomain.com';
    var number = '1234';

    authenticator.init(domain, number)
      .then(function(mailbox) {

        assert(mailbox.getContext().domain === domain);
        assert(mailbox.mailboxNumber === number);

        done();
      })
      .done();
  });

  it('should throw error for unknown context', function(done) {
    var channel = getMockChannel();
    var authenticator = auth.create(channel);
    var domain = '';
    var number = '1234';

    authenticator.init(domain, number)
      .catch(function(err) {
        assert(err.name === 'ContextNotFound');

        done();
      });
  });

  it('should throw error for unknown mailboxes', function(done) {
    var channel = getMockChannel();
    var authenticator = auth.create(channel);
    var domain = 'mydomain.com';
    var number = '';

    authenticator.init(domain, number)
      .catch(function(err) {
        assert(err.name === 'MailboxNotFound');

        done();
      });
  });

  it('should support setting mailbox via setMailbox', function(done) {
    var channel = getMockChannel();
    var authenticator = auth.create(channel);
    var domain = 'mydomain.com';
    var number = '1234';

    authenticator.init(domain, '')
      .catch(function(err) {
        assert(err.name === 'MailboxNotFound');

        authenticator.setMailbox(number)
          .then(function(mailbox) {

            assert(mailbox.getContext().domain === domain);
            assert(mailbox.mailboxNumber === number);

            done();
          });
      })
      .done();
  });

  it('should throw error for unknown mailbox on setMailbox', function(done) {
    var channel = getMockChannel();
    var authenticator = auth.create(channel);
    var domain = 'mydomain.com';
    var number = '';

    authenticator.init(domain, number)
      .catch(function(err) {
        assert(err.name === 'MailboxNotFound');

        authenticator.setMailbox(number)
          .catch(function(err) {
            assert(err.name === 'MailboxNotFound');

            done();
          });
      })
      .done();
  });

  it('should support authenticating against a password', function(done) {
    var channel = getMockChannel();
    var authenticator = auth.create(channel);
    var domain = 'mydomain.com';
    var number = '1234';
    var password = 'mypassword';

    authenticator.init(domain, number)
      .then(function(mailbox) {

        assert(mailbox.getContext().domain === domain);
        assert(mailbox.mailboxNumber === number);

        return authenticator.authenticate(password);
      })
      .then(function() {
        done();
      })
      .done();
  });

  it('should throw error for invalid password', function(done) {
    var channel = getMockChannel();
    var authenticator = auth.create(channel);
    var domain = 'mydomain.com';
    var number = '1234';
    var password = 'notmypassword';

    authenticator.init(domain, number)
      .then(function(mailbox) {

        assert(mailbox.getContext().domain === domain);
        assert(mailbox.mailboxNumber === number);

        return authenticator.authenticate(password);
      })
      .catch(function(err) {
        assert(err.name === 'InvalidPassword');

        done();
      })
      .done();
  });

  it('should support channel hanging up', function(done) {
    var channel = getMockChannel();
    var authenticator = auth.create(channel);
    var domain = 'mydomain.com';
    var number = '1234';
    var password = 'mypassword';

    authenticator.init(domain, number)
      .then(function(mailbox) {

        assert(mailbox.getContext().domain === domain);
        assert(mailbox.mailboxNumber === number);

        var promise =  authenticator.authenticate(password);

        channel.emit('StasisEnd');
        return promise;
      })
      .catch(function(err) {
        assert(err.name === 'ChannelHungup');

        done();
      })
      .done();
  });

});
