# Asterisk Voicemail Authentication Interface

Authentication module for Asterisk voicemail. This module supports authenticating and authorizing users.

# Installation

```bash
$ git clone https://github.com/asterisk/node-voicemail-auth.git
$ cd node-voicemail-auth
$ npm install -g .
```

or add the following the your package.json file

```JavaScript
"dependencies": {
  "voicemail-auth": "asterisk/node-voicemail-auth"
}
```

# Usage

Create an authenticator:

```JavaScript
var dal; // voicemail data access layer instance
var promptHelper; // voicemail prompt instance
var config; // voicemail config instance
var auth = require('voicemail-auth')({
  dal: dal,
  prompt: promptHelper,
  config, config,
  logger: logger // voicemail logging
});
var channel; // channel instance

var authenticator = auth.create(channel);

// initialize with domain/mailbox number
authenticator.init('domain.com', '1234')
  .then(function(mailbox) {
    // use mailbox instance...
  })
  .catch(function (err) {
    err.name; // 'ContextNotFound' or 'MailboxNotFound'
  });
```

For more information on voicemail data access layer, see [voicemail-data](http://github.com/asterisk/node-voicemail-data). For more information on voicemail prompt, see [voicemail-prompt](http://github.com/asterisk/node-voicemail-prompt). For more information on voicemail config, see [voicemail-config](http://github.com/asterisk/node-voicemail-config)

Set mailbox number for authentication:

```JavaScript
authenticator.setMailbox('1234')
  .then(function(mailbox) {
    // use mailbox instance...
  })
  .catch(function(err) {
    err.name; // 'MailboxNotFound'
  });
```

Attempt to authenticate:

```JavaScript
authenticator.authenticate('password');
  .then(function() {
    // authenticated
  })
  .catch(function(err) {
    err.name; // 'InvalidPassword'
  });
```

To allow authentication to be skipped (for leaving a message for example):

```JavaScript
var authenticator = auth.create(channel, true);
```

You can still call authenticate on the resulting authenticator but it will simply resolve the promise without actually validating the password given against the mailbox.

Note: this module does not currently handle playing authentication related prompts.

# Development

After cloning the git repository, run the following to install the module and all dev dependencies:

```bash
$ npm install
$ npm link
```

Then run the following to run jshint and mocha tests:

```bash
$ grunt
```

jshint will enforce a minimal style guide. It is also a good idea to create unit tests when adding new features.

To generate a test coverage report run the following:

```bash
$ grunt coverage
```

This will also ensure a coverage threshold is met by the tests.

# License

Apache, Version 2.0. Copyright (c) 2014, Digium, Inc. All rights reserved.

