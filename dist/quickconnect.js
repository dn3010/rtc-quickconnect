(function(f){if(typeof exports==="object"&&typeof module!=="undefined"){module.exports=f()}else if(typeof define==="function"&&define.amd){define([],f)}else{var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else if(typeof self!=="undefined"){g=self}else{g=this}g.quickconnect = f()}})(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
(function (process){
/* jshint node: true */
/* global location */
'use strict';

var rtc = require('rtc-tools');
var mbus = require('mbus');
var detectPlugin = require('rtc-core/plugin');
var debug = rtc.logger('rtc-quickconnect');
var extend = require('cog/extend');

/**
  # rtc-quickconnect

  This is a high level helper module designed to help you get up
  an running with WebRTC really, really quickly.  By using this module you
  are trading off some flexibility, so if you need a more flexible
  configuration you should drill down into lower level components of the
  [rtc.io](http://www.rtc.io) suite.  In particular you should check out
  [rtc](https://github.com/rtc-io/rtc).

  ## Example Usage

  In the simplest case you simply call quickconnect with a single string
  argument which tells quickconnect which server to use for signaling:

  <<< examples/simple.js

  <<< docs/events.md

  <<< docs/examples.md

  ## Regarding Signalling and a Signalling Server

  Signaling is an important part of setting up a WebRTC connection and for
  our examples we use our own test instance of the
  [rtc-switchboard](https://github.com/rtc-io/rtc-switchboard). For your
  testing and development you are more than welcome to use this also, but
  just be aware that we use this for our testing so it may go up and down
  a little.  If you need something more stable, why not consider deploying
  an instance of the switchboard yourself - it's pretty easy :)

  ## Reference

  ```
  quickconnect(signalhost, opts?) => rtc-sigaller instance (+ helpers)
  ```

  ### Valid Quick Connect Options

  The options provided to the `rtc-quickconnect` module function influence the
  behaviour of some of the underlying components used from the rtc.io suite.

  Listed below are some of the commonly used options:

  - `ns` (default: '')

    An optional namespace for your signalling room.  While quickconnect
    will generate a unique hash for the room, this can be made to be more
    unique by providing a namespace.  Using a namespace means two demos
    that have generated the same hash but use a different namespace will be
    in different rooms.

  - `room` (default: null) _added 0.6_

    Rather than use the internal hash generation
    (plus optional namespace) for room name generation, simply use this room
    name instead.  __NOTE:__ Use of the `room` option takes precendence over
    `ns`.

  - `debug` (default: false)

  Write rtc.io suite debug output to the browser console.

  - `expectedLocalStreams` (default: not specified) _added 3.0_

    By providing a positive integer value for this option will mean that
    the created quickconnect instance will wait until the specified number of
    streams have been added to the quickconnect "template" before announcing
    to the signaling server.

  - `manualJoin` (default: `false`)

    Set this value to `true` if you would prefer to call the `join` function
    to connecting to the signalling server, rather than having that happen
    automatically as soon as quickconnect is ready to.

  #### Options for Peer Connection Creation

  Options that are passed onto the
  [rtc.createConnection](https://github.com/rtc-io/rtc#createconnectionopts-constraints)
  function:

  - `iceServers`

  This provides a list of ice servers that can be used to help negotiate a
  connection between peers.

  #### Options for P2P negotiation

  Under the hood, quickconnect uses the
  [rtc/couple](https://github.com/rtc-io/rtc#rtccouple) logic, and the options
  passed to quickconnect are also passed onto this function.

**/
module.exports = function(signaller, opts) {
  var hash = typeof location != 'undefined' && location.hash.slice(1);

  var getPeerData = require('./lib/getpeerdata')(signaller.peers);
  var generateIceServers = require('rtc-core/genice');

  // init configurable vars
  var ns = (opts || {}).ns || '';
  var room = (opts || {}).room;
  var debugging = (opts || {}).debug;
  var allowJoin = !(opts || {}).manualJoin;
  var profile = {};
  var announced = false;

  // Schemes allow customisation about how connections are made
  // In particular, providing schemes allows providing different sets of ICE servers
  // between peers
  var schemes = require('./lib/schemes')(signaller, opts);

  // collect the local streams
  var localStreams = [];

  // create the calls map
  var calls = signaller.calls = require('./lib/calls')(signaller, opts);

  // create the known data channels registry
  var channels = {};
  var pending = {};
  // Reconnecting indicates peers that are in the process of reconnecting
  var reconnecting = {};

  // save the plugins passed to the signaller
  var plugins = signaller.plugins = (opts || {}).plugins || [];
  var plugin = detectPlugin(plugins);
  var pluginReady;

  // check how many local streams have been expected (default: 0)
  var expectedLocalStreams = parseInt((opts || {}).expectedLocalStreams, 10) || 0;
  var announceTimer = 0;
  var updateTimer = 0;

  function checkReadyToAnnounce() {
    clearTimeout(announceTimer);
    // if we have already announced do nothing!
    if (announced) {
      return;
    }

    if (! allowJoin) {
      return;
    }

    // if we have a plugin but it's not initialized we aren't ready
    if (plugin && (! pluginReady)) {
      return;
    }

    // if we are waiting for a set number of streams, then wait until we have
    // the required number
    if (expectedLocalStreams && localStreams.length < expectedLocalStreams) {
      return;
    }

    // announce ourselves to our new friend
    announceTimer = setTimeout(function() {
      var data = extend({ room: room }, profile);

      // announce and emit the local announce event
      signaller.announce(data);
      announced = true;
    }, 0);
  }

  function connect(id, connectOpts) {
    debug('connecting to ' + id);
    if (!id) return debug('invalid target peer ID');
    if (pending[id]) {
      return debug('a connection is already pending for ' + id + ', as of ' + (Date.now() - pending[id]) + 'ms ago');
    }
    connectOpts = connectOpts || {};

    var scheme = schemes.get(connectOpts.scheme, true);
    var data = getPeerData(id);
    var pc;
    var monitor;
    var call;

    // if the room is not a match, abort
    if (data.room !== room) {
      return debug('mismatching room, expected: ' + room + ', got: ' + (data && data.room));
    }
    if (data.id !== id) {
      return debug('mismatching ids, expected: ' + id + ', got: ' + data.id);
    }
    pending[id] = Date.now();

    // end any call to this id so we know we are starting fresh
    calls.end(id);

    signaller('peer:prepare', id, data, scheme);

    function clearPending(msg) {
      debug('connection for ' + id + ' is no longer pending [' + (msg || 'no reason') + '], connect available again');
      if (pending[id]) {
        delete pending[id];
      }
      if (reconnecting[id]) {
        delete reconnecting[id];
      }
    }

    // Regenerate ICE servers (or use existing cached ICE)
    generateIceServers(extend({targetPeer: id}, opts, (scheme || {}).connection), function(err, iceServers) {
      if (err) {
        signaller('icegeneration:error', id, scheme && scheme.id, err);
      } else {
        signaller('peer:iceservers', id, scheme && scheme.id, iceServers || []);
      }

      // create a peer connection
      // iceServers that have been created using genice taking precendence
      pc = rtc.createConnection(
        extend({}, opts, { iceServers: iceServers }),
        (opts || {}).constraints
      );

      signaller('peer:connect', id, pc, data);

      // add this connection to the calls list
      call = calls.create(id, pc, data);

      // add the local streams
      localStreams.forEach(function(stream) {
        pc.addStream(stream);
      });

      // add the data channels
      // do this differently based on whether the connection is a
      // master or a slave connection
      if (signaller.isMaster(id)) {
        debug('is master, creating data channels: ', Object.keys(channels));

        // create the channels
        Object.keys(channels).forEach(function(label) {
         gotPeerChannel(pc.createDataChannel(label, channels[label]), pc, data);
        });
      }
      else {
        pc.ondatachannel = function(evt) {
          var channel = evt && evt.channel;

          // if we have no channel, abort
          if (! channel) {
            return;
          }

          if (channels[channel.label] !== undefined) {
            gotPeerChannel(channel, pc, getPeerData(id));
          }
        };
      }

      // couple the connections
      debug('coupling ' + signaller.id + ' to ' + id);
      monitor = rtc.couple(pc, id, signaller, extend({}, opts, {
        logger: mbus('pc.' + id, signaller)
      }));

      // Apply the monitor to the call
      call.monitor = monitor;

      // once active, trigger the peer connect event
      monitor.once('connected', function() {
        clearPending('connected successfully');
        calls.start(id, pc, data);
      });
      monitor.once('closed', function() {
        clearPending('closed');
        calls.end(id);
      });
      monitor.once('aborted', function() {
        clearPending('aborted');
      });
      monitor.once('failed', function() {
        clearPending('failed');
        calls.fail(id);
      });

      // The following states are intermediate states based on the disconnection timer
      monitor.once('failing', calls.failing.bind(null, id));
      monitor.once('recovered', calls.recovered.bind(null, id));

      // Fire the couple event
      signaller('peer:couple', id, pc, data, monitor);

      // if we are the master connnection, create the offer
      // NOTE: this only really for the sake of politeness, as rtc couple
      // implementation handles the slave attempting to create an offer
      if (signaller.isMaster(id)) {
        monitor.createOffer();
      }

      signaller('peer:prepared', id);
    });
  }

  function getActiveCall(peerId) {
    var call = calls.get(peerId);

    if (! call) {
      throw new Error('No active call for peer: ' + peerId);
    }

    return call;
  }

  function gotPeerChannel(channel, pc, data) {
    var channelMonitor;
    var channelConnectionTimer;

    function channelReady() {
      var call = calls.get(data.id);
      var args = [ data.id, channel, data, pc ];

      // decouple the channel.onopen listener
      debug('reporting channel "' + channel.label + '" ready, have call: ' + (!!call));
      clearInterval(channelMonitor);
      clearTimeout(channelConnectionTimer);
      channel.onopen = null;

      // save the channel
      if (call) {
        call.channels.set(channel.label, channel);
      }

      // trigger the %channel.label%:open event
      debug('triggering channel:opened events for channel: ' + channel.label);

      // emit the plain channel:opened event
      signaller.apply(signaller, ['channel:opened'].concat(args));

      // emit the channel:opened:%label% eve
      signaller.apply(
        signaller,
        ['channel:opened:' + channel.label].concat(args)
      );
    }

    // If the channel has failed to create for some reason, recreate the channel
    function recreateChannel() {
      debug('recreating data channel: ' + channel.label);
      // Clear timers
      clearInterval(channelMonitor);
      clearTimeout(channelConnectionTimer);

      // Force the channel to close if it is in an open state
      if (['connecting', 'open'].indexOf(channel.readyState) !== -1) {
        channel.close();
      }

      // Recreate the channel using the cached options
      signaller.createDataChannel(channel.label, channels[channel.label])
    }

    debug('channel ' + channel.label + ' discovered for peer: ' + data.id);
    if (channel.readyState === 'open') {
      return channelReady();
    }

    debug('channel not ready, current state = ' + channel.readyState);
    channel.onopen = channelReady;

    // monitor the channel open (don't trust the channel open event just yet)
    channelMonitor = setInterval(function() {
      debug('checking channel state, current state = ' + channel.readyState + ', connection state ' + pc.iceConnectionState);
      if (channel.readyState === 'open') {
        channelReady();
      }
      // If the underlying connection has failed/closed, then terminate the monitor
      else if (['failed', 'closed'].indexOf(pc.iceConnectionState) !== -1) {
        debug('connection has terminated, cancelling channel monitor');
        clearInterval(channelMonitor);
        clearTimeout(channelConnectionTimer);
      }
      // If the connection has connected, but the channel is stuck in the connecting state
      // start a timer. If this expires, then we will attempt to created the data channel
      else if (pc.iceConnectionState === 'connected' && channel.readyState === 'connecting' && !channelConnectionTimer) {
        channelConnectionTimer = setTimeout(function() {
          if (channel.readyState !== 'connecting') return;
          var args = [ data.id, channel, data, pc ];

          // emit the plain channel:failed event
          signaller.apply(signaller, ['channel:failed'].concat(args));

          // emit the channel:opened:%label% eve
          signaller.apply(
            signaller,
            ['channel:failed:' + channel.label].concat(args)
          );

          // Recreate the channel
          return recreateChannel();
        }, (opts || {}).channelTimeout || 2000);
      }

    }, 500);
  }

  function initPlugin() {
    return plugin && plugin.init(opts, function(err) {
      if (err) {
        return console.error('Could not initialize plugin: ', err);
      }

      pluginReady = true;
      checkReadyToAnnounce();
    });
  }

  function handleLocalAnnounce(data) {
    // if we send an announce with an updated room then update our local room name
    if (data && typeof data.room != 'undefined') {
      room = data.room;
    }
  }

  function handlePeerFilter(id, data) {
    // only connect with the peer if we are ready
    data.allow = data.allow && (localStreams.length >= expectedLocalStreams);
  }

  function handlePeerUpdate(data) {
    // Do not allow peer updates if we are not announced
    if (!announced) return;

    var id = data && data.id;
    var activeCall = id && calls.get(id);

    // if we have received an update for a peer that has no active calls,
    // and is not currently in the process of setting up a call
    // then pass this onto the announce handler
    if (id && (! activeCall) && !pending[id] && !reconnecting[id]) {
      debug('received peer update from peer ' + id + ', no active calls');
      signaller('peer:autoreconnect', id);
      return signaller.reconnectTo(id);
    }
  }

  function handlePeerLeave(data) {
    var id = data && data.id;
    if (id) {
      delete pending[id];
      calls.end(id);
    }
  }

  function handlePeerClose(id) {
    if (!announced) return;
    delete pending[id];
    debug('call has from ' + signaller.id + ' to ' + id + ' has ended, reannouncing');
    return signaller.profile();
  }

  // if the room is not defined, then generate the room name
  if (! room) {
    // if the hash is not assigned, then create a random hash value
    if (typeof location != 'undefined' && (! hash)) {
      hash = location.hash = '' + (Math.pow(2, 53) * Math.random());
    }

    room = ns + '#' + hash;
  }

  if (debugging) {
    rtc.logger.enable.apply(rtc.logger, Array.isArray(debug) ? debugging : ['*']);
  }

  signaller.on('peer:announce', function(data) {
    connect(data.id, { scheme: data.scheme });
  });

  signaller.on('peer:update', handlePeerUpdate);

  signaller.on('message:reconnect', function(data, sender, message) {
    debug('received reconnect message');

    // Sender arguments are always last
    if (!message) {
      message = sender;
      sender = data;
      data = undefined;
    }
    if (!sender.id) return console.warn('Could not reconnect, no sender ID');

    // Abort any current calls
    calls.abort(sender.id);
    delete reconnecting[sender.id];
    signaller('peer:reconnecting', sender.id, data || {});
    connect(sender.id, data || {});

    // If this is the master, echo the reconnection back to the peer instructing that
    // the reconnection has been accepted and to connect
    var isMaster = signaller.isMaster(sender.id);
    if (isMaster) {
      signaller.to(sender.id).send('/reconnect', data || {});
    }
  });

  /**
    ### Quickconnect Broadcast and Data Channel Helper Functions

    The following are functions that are patched into the `rtc-signaller`
    instance that make working with and creating functional WebRTC applications
    a lot simpler.

  **/

  /**
    #### addStream

    ```
    addStream(stream:MediaStream) => qc
    ```

    Add the stream to active calls and also save the stream so that it
    can be added to future calls.

  **/
  signaller.broadcast = signaller.addStream = function(stream) {
    localStreams.push(stream);

    // if we have any active calls, then add the stream
    calls.values().forEach(function(data) {
      data.pc.addStream(stream);
    });

    checkReadyToAnnounce();
    return signaller;
  };

  /**
    #### endCall

    The `endCall` function terminates the active call with the given ID.
    If a call with the call ID does not exist it will do nothing.
  **/
  signaller.endCall = calls.end;

  /**
    #### endCalls()

    The `endCalls` function terminates all the active calls that have been
    created in this quickconnect instance.  Calling `endCalls` does not
    kill the connection with the signalling server.

  **/
  signaller.endCalls = function() {
    calls.keys().forEach(calls.end);
  };

  /**
    #### close()

    The `close` function provides a convenient way of closing all associated
    peer connections.  This function simply uses the `endCalls` function and
    the underlying `leave` function of the signaller to do a "full cleanup"
    of all connections.
  **/
  signaller.close = function() {
    // We are no longer announced
    announced = false;

    // Remove any pending update annoucements
    if (updateTimer) clearTimeout(updateTimer);

    // Cleanup
    signaller.endCalls();
    signaller.leave();
  };

  /**
    #### createDataChannel(label, config)

    Request that a data channel with the specified `label` is created on
    the peer connection.  When the data channel is open and available, an
    event will be triggered using the label of the data channel.

    For example, if a new data channel was requested using the following
    call:

    ```js
    var qc = quickconnect('https://switchboard.rtc.io/').createDataChannel('test');
    ```

    Then when the data channel is ready for use, a `test:open` event would
    be emitted by `qc`.

  **/
  signaller.createDataChannel = function(label, opts) {
    // create a channel on all existing calls
    calls.keys().forEach(function(peerId) {
      var call = calls.get(peerId);
      var dc;

      // if we are the master connection, create the data channel
      if (call && call.pc && signaller.isMaster(peerId)) {
        dc = call.pc.createDataChannel(label, opts);
        gotPeerChannel(dc, call.pc, getPeerData(peerId));
      }
    });

    // save the data channel opts in the local channels dictionary
    channels[label] = opts || null;

    return signaller;
  };

  /**
    #### join()

    The `join` function is used when `manualJoin` is set to true when creating
    a quickconnect instance.  Call the `join` function once you are ready to
    join the signalling server and initiate connections with other people.

  **/
  signaller.join = function() {
    allowJoin = true;
    checkReadyToAnnounce();
  };

  /**
    #### `get(name)`

    The `get` function returns the property value for the specified property name.
  **/
  signaller.get = function(name) {
    return profile[name];
  };

  /**
    #### `getLocalStreams()`

    Return a copy of the local streams that have currently been configured
  **/
  signaller.getLocalStreams = function() {
    return [].concat(localStreams);
  };

  /**
    #### reactive()

    Flag that this session will be a reactive connection.

  **/
  signaller.reactive = function() {
    // add the reactive flag
    opts = opts || {};
    opts.reactive = true;

    // chain
    return signaller;
  };

  /**
    #### registerScheme

    Registers a connection scheme for use, and check it for validity
   **/
  signaller.registerScheme = schemes.add;

  /**
   #### getSche,e

   Returns the connection sheme given by ID
  **/
  signaller.getScheme = schemes.get;

  /**
    #### removeStream

    ```
    removeStream(stream:MediaStream)
    ```

    Remove the specified stream from both the local streams that are to
    be connected to new peers, and also from any active calls.

  **/
  signaller.removeStream = function(stream) {
    var localIndex = localStreams.indexOf(stream);

    // remove the stream from any active calls
    calls.values().forEach(function(call) {

      // If `RTCPeerConnection.removeTrack` exists (Firefox), then use that
      // as `RTCPeerConnection.removeStream` is not supported
      if (call.pc.removeTrack) {
        stream.getTracks().forEach(function(track) {
          try {
            call.pc.removeTrack(track);
          } catch (e) {
            // When using LocalMediaStreamTracks, this seems to throw an error due to
            // LocalMediaStreamTrack not implementing the RTCRtpSender inteface.
            // Without `removeStream` and with `removeTrack` not allowing for local stream
            // removal, this needs some thought when dealing with FF renegotiation
            console.error('Error removing media track', e);
          }
        });
      }
      // Otherwise we just use `RTCPeerConnection.removeStream`
      else {
        try {
          call.pc.removeStream(stream);
        } catch (e) {
          console.error('Failed to remove media stream', e);
        }
      }
    });

    // remove the stream from the localStreams array
    if (localIndex >= 0) {
      localStreams.splice(localIndex, 1);
    }

    return signaller;
  };

  /**
    #### requestChannel

    ```
    requestChannel(targetId, label, callback)
    ```

    This is a function that can be used to respond to remote peers supplying
    a data channel as part of their configuration.  As per the `receiveStream`
    function this function will either fire the callback immediately if the
    channel is already available, or once the channel has been discovered on
    the call.

  **/
  signaller.requestChannel = function(targetId, label, callback) {
    var call = getActiveCall(targetId);
    var channel = call && call.channels.get(label);

    // if we have then channel trigger the callback immediately
    if (channel) {
      callback(null, channel);
      return signaller;
    }

    // if not, wait for it
    signaller.once('channel:opened:' + label, function(id, dc) {
      callback(null, dc);
    });

    return signaller;
  };

  /**
    #### requestStream

    ```
    requestStream(targetId, idx, callback)
    ```

    Used to request a remote stream from a quickconnect instance. If the
    stream is already available in the calls remote streams, then the callback
    will be triggered immediately, otherwise this function will monitor
    `stream:added` events and wait for a match.

    In the case that an unknown target is requested, then an exception will
    be thrown.
  **/
  signaller.requestStream = function(targetId, idx, callback) {
    var call = getActiveCall(targetId);
    var stream;

    function waitForStream(peerId) {
      if (peerId !== targetId) {
        return;
      }

      // get the stream
      stream = call.pc.getRemoteStreams()[idx];

      // if we have the stream, then remove the listener and trigger the cb
      if (stream) {
        signaller.removeListener('stream:added', waitForStream);
        callback(null, stream);
      }
    }

    // look for the stream in the remote streams of the call
    stream = call.pc.getRemoteStreams()[idx];

    // if we found the stream then trigger the callback
    if (stream) {
      callback(null, stream);
      return signaller;
    }

    // otherwise wait for the stream
    signaller.on('stream:added', waitForStream);
    return signaller;
  };

  /**
    #### profile(data)

    Update the profile data with the attached information, so when
    the signaller announces it includes this data in addition to any
    room and id information.

  **/
  signaller.profile = function(data) {
    extend(profile, data || {});

    // if we have already announced, then reannounce our profile to provide
    // others a `peer:update` event
    if (announced) {
      clearTimeout(updateTimer);
      updateTimer = setTimeout(function() {
        // Check that our announced status hasn't changed
        if (!announced) return;
        debug('[' + signaller.id + '] reannouncing');
        signaller.announce(profile);
      }, (opts || {}).updateDelay || 1000);
    }

    return signaller;
  };

  /**
    #### waitForCall

    ```
    waitForCall(targetId, callback)
    ```

    Wait for a call from the specified targetId.  If the call is already
    active the callback will be fired immediately, otherwise we will wait
    for a `call:started` event that matches the requested `targetId`

  **/
  signaller.waitForCall = function(targetId, callback) {
    var call = calls.get(targetId);

    if (call && call.active) {
      callback(null, call.pc);
      return signaller;
    }

    signaller.on('call:started', function handleNewCall(id) {
      if (id === targetId) {
        signaller.removeListener('call:started', handleNewCall);
        callback(null, calls.get(id).pc);
      }
    });
  };

  /**
    Attempts to reconnect to a certain target peer. It will close any existing
    call to that peer, and restart the connection process
   **/
  signaller.reconnectTo = function(id, reconnectOpts) {
    if (!id) return;
    signaller.to(id).send('/reconnect', reconnectOpts);
    // If this is the master, connect, otherwise the master will send a /reconnect
    // message back instructing the connection to start
    var isMaster = signaller.isMaster(id);
    if (isMaster) {

      // Abort any current calls
      signaller('log', 'aborting call');
      try {
        calls.abort(id);
      } catch(e) {
        signaller('log', e.message);
      }
      signaller('log', 'call aborted');
      signaller('peer:reconnecting', id, reconnectOpts || {});
      return connect(id, reconnectOpts);
    }
    // Flag that we are waiting for the master to indicate the reconnection is a go
    else {
      reconnecting[id] = Date.now();
    }
  };

  // if we have an expected number of local streams, then use a filter to
  // check if we should respond
  if (expectedLocalStreams) {
    signaller.on('peer:filter', handlePeerFilter);
  }

  // respond to local announce messages
  signaller.on('local:announce', handleLocalAnnounce);

  // handle ping messages
  signaller.on('message:ping', calls.ping);

  // Handle when a remote peer leaves that the appropriate closing occurs this
  // side as well
  signaller.on('message:leave', handlePeerLeave);

  // When a call:ended, we reannounce ourselves. This offers a degree of failure handling
  // as if a call has dropped unexpectedly (ie. failure/unable to connect) the other peers
  // connected to the signaller will attempt to reconnect
  signaller.on('call:ended', handlePeerClose);

  // if we plugin is active, then initialize it
  if (plugin) {
    initPlugin();
  } else {
    // Test if we are ready to announce
    process.nextTick(function() {
      checkReadyToAnnounce();
    });
  }

  // pass the signaller on
  return signaller;
};

}).call(this,require('_process'))

},{"./lib/calls":2,"./lib/getpeerdata":3,"./lib/schemes":5,"_process":16,"cog/extend":7,"mbus":14,"rtc-core/genice":19,"rtc-core/plugin":20,"rtc-tools":29}],2:[function(require,module,exports){
(function (process){
var rtc = require('rtc-tools');
var debug = rtc.logger('rtc-quickconnect');
var cleanup = require('rtc-tools/cleanup');
var getable = require('cog/getable');

module.exports = function(signaller, opts) {
  var calls = getable({});
  var getPeerData = require('./getpeerdata')(signaller.peers);
  var heartbeats = require('./heartbeat')(signaller, opts);
  var debugPrefix = '[' + signaller.id + '] ';

  function create(id, pc, data) {
    var heartbeat = heartbeats.create(id);
    var call = {
      active: false,
      signalling: false,
      pc: pc,
      channels: getable({}),
      streams: [],
      lastping: Date.now(),
      heartbeat: heartbeat
    };
    calls.set(id, call);

    // Detect changes to the communication with this peer via
    // the signaller
    heartbeat.on('signalling:state', function(connected) {
      call.signalling = connected;
    });

    // Indicate the call creation
    debug(debugPrefix + 'call has been created for ' + id + ' (not yet started)');
    signaller('call:created', id, pc, data);
    return call;
  }

  function createStreamAddHandler(id) {
    return function(evt) {
      debug(debugPrefix + 'peer ' + id + ' added stream');
      updateRemoteStreams(id);
      receiveRemoteStream(id)(evt.stream);
    };
  }

  function createStreamRemoveHandler(id) {
    return function(evt) {
      debug(debugPrefix + 'peer ' + id + ' removed stream');
      updateRemoteStreams(id);
      signaller('stream:removed', id, evt.stream);
    };
  }

  /**
    Failing is invoked when a call in the process of failing, usually as a result
    of a disconnection in the PeerConnection. A connection that is failing can
    be recovered, however, encountering this state does indicate the call is in trouble
   **/
  function failing(id) {
    var call = calls.get(id);
    // If no call exists, do nothing
    if (!call) {
      return;
    }

    debug(debugPrefix + 'call is failing for ' + id);
    signaller('call:failing', id, call && call.pc);
  }

  /**
    Recovered is invoked when a call which was previously failing has recovered. Namely,
    the PeerConnection has been restored by connectivity being reestablished (primary cause
    would probably be network connection drop outs, such as WiFi)
   **/
  function recovered(id) {
    var call = calls.get(id);
    // If no call exists, do nothing
    if (!call) {
      return;
    }

    debug(debugPrefix + 'call has recovered for ' + id);
    signaller('call:recovered', id, call && call.pc);
  }

  function fail(id) {
    var call = calls.get(id);
    // If no call exists, do nothing
    if (!call) {
      return;
    }

    debug(debugPrefix + 'call has failed for ' + id);
    signaller('call:failed', id, call && call.pc);
    end(id);
  }

  /**
    Stops the coupling process for a call
   **/
  function abort(id) {
    var call = calls.get(id);
    // If no call, do nothing
    if (!call) return;

    if (call.monitor) call.monitor.abort();
    signaller('call:aborted', id, call && call.pc);
    end(id);
  }

  function end(id) {
    var call = calls.get(id);

    // if we have no data, then do nothing
    if (! call) {
      return;
    }

    // Stop the heartbeat
    if (call.heartbeat) {
      call.heartbeat.stop();
    }

    // If a monitor is attached, remove all listeners
    if (call.monitor) {
      call.monitor.stop();
    }

    // if we have no data, then return
    call.channels.keys().forEach(function(label) {
      var channel = call.channels.get(label);
      var args = [id, channel, label];

      // emit the plain channel:closed event
      signaller.apply(signaller, ['channel:closed'].concat(args));

      // emit the labelled version of the event
      signaller.apply(signaller, ['channel:closed:' + label].concat(args));

      // decouple the events
      channel.onopen = null;
    });

    // trigger stream:removed events for each of the remotestreams in the pc
    call.streams.forEach(function(stream) {
      signaller('stream:removed', id, stream);
    });

    // delete the call data
    calls.delete(id);

    // trigger the call:ended event
    debug(debugPrefix + 'call has ended for ' + id);
    signaller('call:ended', id, call.pc);
    signaller('call:' + id + ':ended', call.pc);

    // ensure the peer connection is properly cleaned up
    cleanup(call.pc);
  }

  function ping(sender) {
    var call = calls.get(sender && sender.id);

    // set the last ping for the data
    if (call) {
      call.lastping = Date.now();
      call.heartbeat.touch();
    }
  }

  function receiveRemoteStream(id) {
    return function(stream) {
      signaller('stream:added', id, stream, getPeerData(id));
    };
  }

  function start(id, pc, data) {
    var call = calls.get(id);
    var streams = [].concat(pc.getRemoteStreams());

    // flag the call as active
    call.active = true;
    call.streams = [].concat(pc.getRemoteStreams());

    pc.onaddstream = createStreamAddHandler(id);
    pc.onremovestream = createStreamRemoveHandler(id);

    debug(debugPrefix + ' -> ' + id + ' call start: ' + streams.length + ' streams');
    signaller('call:started', id, pc, data);

    // configure the heartbeat timer
    call.lastping = Date.now();

    // Monitor the heartbeat for signaller disconnection
    call.heartbeat.once('disconnected', function() {
      signaller('call:expired', id, call.pc);
      return end(id);
    });

    // examine the existing remote streams after a short delay
    process.nextTick(function() {
      // iterate through any remote streams
      streams.forEach(receiveRemoteStream(id));
    });
  }

  function updateRemoteStreams(id) {
    var call = calls.get(id);

    if (call && call.pc) {
      call.streams = [].concat(call.pc.getRemoteStreams());
    }
  }

  calls.abort = abort;
  calls.create = create;
  calls.end = end;
  calls.fail = fail;
  calls.failing = failing;
  calls.ping = ping;
  calls.start = start;
  calls.recovered = recovered;

  return calls;
};

}).call(this,require('_process'))

},{"./getpeerdata":3,"./heartbeat":4,"_process":16,"cog/getable":8,"rtc-tools":29,"rtc-tools/cleanup":25}],3:[function(require,module,exports){
module.exports = function(peers) {
  return function(id) {
    var peer = peers.get(id);
    return peer && peer.data;
  };
};

},{}],4:[function(require,module,exports){
var mbus = require('mbus');

module.exports = function(signaller, opts) {

  opts = opts || {};

  /**
    Creates a new heartbeat
   **/
  function create(id) {

    var heartbeat = mbus();
    var delay = (typeof opts.heartbeat === 'number' ? opts.heartbeat : 2500);
    var ignoreDisconnection = (opts || {}).ignoreDisconnection || false; //if you want to rely on your switchboard to tell if the call is still going
    var timer = null;
    var connected = false;
    var lastping = 0;

    /**
      Pings the target peer
     **/
    function ping() {
      signaller.to(id).send('/ping');
    }

    /**
      Checks the state of the signaller connection
     **/
    function check() {
      var tickInactive = (Date.now() - (delay * 4)); //doesnt always work

      var currentlyConnected = ignoreDisconnection ? ignoreDisconnection : (lastping >= tickInactive);
      // If we have changed connection state, flag the change
      if (connected !== currentlyConnected) {
        heartbeat(currentlyConnected ? 'connected' : 'disconnected');
        heartbeat('signalling:state', currentlyConnected);
        connected = currentlyConnected;
      }
    }

    /**
      Checks the state of the connection, and pings as well
     **/
    function beat() {
      check();
      ping();
    }

    /**
      Starts the heartbeat
     **/
    heartbeat.start = function() {
      if (timer) heartbeat.stop();
      if (delay <= 0) return;

      timer = setInterval(beat, delay);
      beat();
    };

    /**
      Stops the heartbeat
     **/
    heartbeat.stop = function() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    };

    /**
      Registers the receipt on a ping
     **/
    heartbeat.touch = function() {
      lastping = Date.now();
      check();
    };

    /**
      Updates the delay interval
     **/
    heartbeat.updateDelay = function(value) {
      delay = value;
      heartbeat.start();
    };

    heartbeat.start();
    return heartbeat;
  }

  return {
    create: create
  };
};

},{"mbus":14}],5:[function(require,module,exports){
var rtc = require('rtc-tools');
var debug = rtc.logger('rtc-quickconnect');

/**
  Schemes allow multiple connection schemes for selection when attempting to connect to
  a peer
 **/
module.exports = function(signaller, opts) {

  var schemes = {};
  var _default;

  /**
    Adds a connection scheme
   **/
  function add(scheme) {
    // Ensure valid ID
    if (!scheme || !scheme.id || typeof scheme.id !== 'string') {
      throw new Error('Cannot add invalid scheme. Requires at least an ID');
    }
    // Unique schemes
    if (schemes[scheme.id]) {
      throw new Error('Scheme ' + schemeId + ' already exists');
    }
    // Check default
    if (scheme.isDefault) {
      if (_default) {
        console.warn('Default scheme already exists');
      } else {
        _default = scheme.id;
      }
    }

    schemes[scheme.id] = scheme;
  }

  /**
    Returns the scheme with the given ID. If canDefault is true it will return the default scheme
    if no scheme with ID is found
   **/
  function get(id, canDefault) {
    return schemes[id] || (canDefault && _default ? schemes[_default] : undefined);
  }

  // Load passed in schemes
  if (opts && opts.schemes && Array.isArray(opts.schemes)) {
    opts.schemes.forEach(add);
  }

  return {
    add: add,
    get: get
  };
};
},{"rtc-tools":29}],6:[function(require,module,exports){
/* jshint node: true */
'use strict';

/**
## cog/defaults

```js
var defaults = require('cog/defaults');
```

### defaults(target, *)

Shallow copy object properties from the supplied source objects (*) into
the target object, returning the target object once completed.  Do not,
however, overwrite existing keys with new values:

```js
defaults({ a: 1, b: 2 }, { c: 3 }, { d: 4 }, { b: 5 }));
```

See an example on [requirebin](http://requirebin.com/?gist=6079475).
**/
module.exports = function(target) {
  // ensure we have a target
  target = target || {};

  // iterate through the sources and copy to the target
  [].slice.call(arguments, 1).forEach(function(source) {
    if (! source) {
      return;
    }

    for (var prop in source) {
      if (target[prop] === void 0) {
        target[prop] = source[prop];
      }
    }
  });

  return target;
};
},{}],7:[function(require,module,exports){
/* jshint node: true */
'use strict';

/**
## cog/extend

```js
var extend = require('cog/extend');
```

### extend(target, *)

Shallow copy object properties from the supplied source objects (*) into
the target object, returning the target object once completed:

```js
extend({ a: 1, b: 2 }, { c: 3 }, { d: 4 }, { b: 5 }));
```

See an example on [requirebin](http://requirebin.com/?gist=6079475).
**/
module.exports = function(target) {
  [].slice.call(arguments, 1).forEach(function(source) {
    if (! source) {
      return;
    }

    for (var prop in source) {
      target[prop] = source[prop];
    }
  });

  return target;
};
},{}],8:[function(require,module,exports){
/**
  ## cog/getable

  Take an object and provide a wrapper that allows you to `get` and
  `set` values on that object.

**/
module.exports = function(target) {
  function get(key) {
    return target[key];
  }

  function set(key, value) {
    target[key] = value;
  }

  function remove(key) {
    return delete target[key];
  }

  function keys() {
    return Object.keys(target);
  };

  function values() {
    return Object.keys(target).map(function(key) {
      return target[key];
    });
  };

  if (typeof target != 'object') {
    return target;
  }

  return {
    get: get,
    set: set,
    remove: remove,
    delete: remove,
    keys: keys,
    values: values
  };
};

},{}],9:[function(require,module,exports){
/* jshint node: true */
'use strict';

/**
  ## cog/logger

  ```js
  var logger = require('cog/logger');
  ```

  Simple browser logging offering similar functionality to the
  [debug](https://github.com/visionmedia/debug) module.

  ### Usage

  Create your self a new logging instance and give it a name:

  ```js
  var debug = logger('phil');
  ```

  Now do some debugging:

  ```js
  debug('hello');
  ```

  At this stage, no log output will be generated because your logger is
  currently disabled.  Enable it:

  ```js
  logger.enable('phil');
  ```

  Now do some more logger:

  ```js
  debug('Oh this is so much nicer :)');
  // --> phil: Oh this is some much nicer :)
  ```

  ### Reference
**/

var active = [];
var unleashListeners = [];
var targets = [ console ];

/**
  #### logger(name)

  Create a new logging instance.
**/
var logger = module.exports = function(name) {
  // initial enabled check
  var enabled = checkActive();

  function checkActive() {
    return enabled = active.indexOf('*') >= 0 || active.indexOf(name) >= 0;
  }

  // register the check active with the listeners array
  unleashListeners[unleashListeners.length] = checkActive;

  // return the actual logging function
  return function() {
    var args = [].slice.call(arguments);

    // if we have a string message
    if (typeof args[0] == 'string' || (args[0] instanceof String)) {
      args[0] = name + ': ' + args[0];
    }

    // if not enabled, bail
    if (! enabled) {
      return;
    }

    // log
    targets.forEach(function(target) {
      target.log.apply(target, args);
    });
  };
};

/**
  #### logger.reset()

  Reset logging (remove the default console logger, flag all loggers as
  inactive, etc, etc.
**/
logger.reset = function() {
  // reset targets and active states
  targets = [];
  active = [];

  return logger.enable();
};

/**
  #### logger.to(target)

  Add a logging target.  The logger must have a `log` method attached.

**/
logger.to = function(target) {
  targets = targets.concat(target || []);

  return logger;
};

/**
  #### logger.enable(names*)

  Enable logging via the named logging instances.  To enable logging via all
  instances, you can pass a wildcard:

  ```js
  logger.enable('*');
  ```

  __TODO:__ wildcard enablers
**/
logger.enable = function() {
  // update the active
  active = active.concat([].slice.call(arguments));

  // trigger the unleash listeners
  unleashListeners.forEach(function(listener) {
    listener();
  });

  return logger;
};
},{}],10:[function(require,module,exports){
/* jshint node: true */
'use strict';

/**
  ## cog/throttle

  ```js
  var throttle = require('cog/throttle');
  ```

  ### throttle(fn, delay, opts)

  A cherry-pickable throttle function.  Used to throttle `fn` to ensure
  that it can be called at most once every `delay` milliseconds.  Will
  fire first event immediately, ensuring the next event fired will occur
  at least `delay` milliseconds after the first, and so on.

**/
module.exports = function(fn, delay, opts) {
  var lastExec = (opts || {}).leading !== false ? 0 : Date.now();
  var trailing = (opts || {}).trailing;
  var timer;
  var queuedArgs;
  var queuedScope;

  // trailing defaults to true
  trailing = trailing || trailing === undefined;
  
  function invokeDefered() {
    fn.apply(queuedScope, queuedArgs || []);
    lastExec = Date.now();
  }

  return function() {
    var tick = Date.now();
    var elapsed = tick - lastExec;

    // always clear the defered timer
    clearTimeout(timer);

    if (elapsed < delay) {
      queuedArgs = [].slice.call(arguments, 0);
      queuedScope = this;

      return trailing && (timer = setTimeout(invokeDefered, delay - elapsed));
    }

    // call the function
    lastExec = tick;
    fn.apply(this, arguments);
  };
};
},{}],11:[function(require,module,exports){
var detectBrowser = require('./lib/detectBrowser');

module.exports = detectBrowser(navigator.userAgent);

},{"./lib/detectBrowser":12}],12:[function(require,module,exports){
module.exports = function detectBrowser(userAgentString) {
  var browsers = [
    [ 'edge', /Edge\/([0-9\._]+)/ ],
    [ 'chrome', /(?!Chrom.*OPR)Chrom(?:e|ium)\/([0-9\.]+)(:?\s|$)/ ],
    [ 'crios', /CriOS\/([0-9\.]+)(:?\s|$)/ ],
    [ 'firefox', /Firefox\/([0-9\.]+)(?:\s|$)/ ],
    [ 'opera', /Opera\/([0-9\.]+)(?:\s|$)/ ],
    [ 'opera', /OPR\/([0-9\.]+)(:?\s|$)$/ ],
    [ 'ie', /Trident\/7\.0.*rv\:([0-9\.]+)\).*Gecko$/ ],
    [ 'ie', /MSIE\s([0-9\.]+);.*Trident\/[4-7].0/ ],
    [ 'ie', /MSIE\s(7\.0)/ ],
    [ 'bb10', /BB10;\sTouch.*Version\/([0-9\.]+)/ ],
    [ 'android', /Android\s([0-9\.]+)/ ],
    [ 'ios', /iPad.*Version\/([0-9\._]+)/ ],
    [ 'ios',  /iPhone.*Version\/([0-9\._]+)/ ],
    [ 'safari', /Version\/([0-9\._]+).*Safari/ ]
  ];

  var i = 0, mapped =[];
  for (i = 0; i < browsers.length; i++) {
    browsers[i] = createMatch(browsers[i]);
    if (isMatch(browsers[i])) {
      mapped.push(browsers[i]);
    }
  }

  var match = mapped[0];
  var parts = match && match[3].split(/[._]/).slice(0,3);

  while (parts && parts.length < 3) {
    parts.push('0');
  }

  function createMatch(pair) {
    return pair.concat(pair[1].exec(userAgentString));
  }

  function isMatch(pair) {
    return !!pair[2];
  }

  // return the name and version
  return {
    name: match && match[0],
    version: parts && parts.join('.'),
  };
};

},{}],13:[function(require,module,exports){
(function (process,global){
/*!
 * @overview es6-promise - a tiny implementation of Promises/A+.
 * @copyright Copyright (c) 2014 Yehuda Katz, Tom Dale, Stefan Penner and contributors (Conversion to ES6 API by Jake Archibald)
 * @license   Licensed under MIT license
 *            See https://raw.githubusercontent.com/stefanpenner/es6-promise/master/LICENSE
 * @version   3.3.1
 */

(function (global, factory) {
    typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory() :
    typeof define === 'function' && define.amd ? define(factory) :
    (global.ES6Promise = factory());
}(this, (function () { 'use strict';

function objectOrFunction(x) {
  return typeof x === 'function' || typeof x === 'object' && x !== null;
}

function isFunction(x) {
  return typeof x === 'function';
}

var _isArray = undefined;
if (!Array.isArray) {
  _isArray = function (x) {
    return Object.prototype.toString.call(x) === '[object Array]';
  };
} else {
  _isArray = Array.isArray;
}

var isArray = _isArray;

var len = 0;
var vertxNext = undefined;
var customSchedulerFn = undefined;

var asap = function asap(callback, arg) {
  queue[len] = callback;
  queue[len + 1] = arg;
  len += 2;
  if (len === 2) {
    // If len is 2, that means that we need to schedule an async flush.
    // If additional callbacks are queued before the queue is flushed, they
    // will be processed by this flush that we are scheduling.
    if (customSchedulerFn) {
      customSchedulerFn(flush);
    } else {
      scheduleFlush();
    }
  }
};

function setScheduler(scheduleFn) {
  customSchedulerFn = scheduleFn;
}

function setAsap(asapFn) {
  asap = asapFn;
}

var browserWindow = typeof window !== 'undefined' ? window : undefined;
var browserGlobal = browserWindow || {};
var BrowserMutationObserver = browserGlobal.MutationObserver || browserGlobal.WebKitMutationObserver;
var isNode = typeof self === 'undefined' && typeof process !== 'undefined' && ({}).toString.call(process) === '[object process]';

// test for web worker but not in IE10
var isWorker = typeof Uint8ClampedArray !== 'undefined' && typeof importScripts !== 'undefined' && typeof MessageChannel !== 'undefined';

// node
function useNextTick() {
  // node version 0.10.x displays a deprecation warning when nextTick is used recursively
  // see https://github.com/cujojs/when/issues/410 for details
  return function () {
    return process.nextTick(flush);
  };
}

// vertx
function useVertxTimer() {
  return function () {
    vertxNext(flush);
  };
}

function useMutationObserver() {
  var iterations = 0;
  var observer = new BrowserMutationObserver(flush);
  var node = document.createTextNode('');
  observer.observe(node, { characterData: true });

  return function () {
    node.data = iterations = ++iterations % 2;
  };
}

// web worker
function useMessageChannel() {
  var channel = new MessageChannel();
  channel.port1.onmessage = flush;
  return function () {
    return channel.port2.postMessage(0);
  };
}

function useSetTimeout() {
  // Store setTimeout reference so es6-promise will be unaffected by
  // other code modifying setTimeout (like sinon.useFakeTimers())
  var globalSetTimeout = setTimeout;
  return function () {
    return globalSetTimeout(flush, 1);
  };
}

var queue = new Array(1000);
function flush() {
  for (var i = 0; i < len; i += 2) {
    var callback = queue[i];
    var arg = queue[i + 1];

    callback(arg);

    queue[i] = undefined;
    queue[i + 1] = undefined;
  }

  len = 0;
}

function attemptVertx() {
  try {
    var r = require;
    var vertx = r('vertx');
    vertxNext = vertx.runOnLoop || vertx.runOnContext;
    return useVertxTimer();
  } catch (e) {
    return useSetTimeout();
  }
}

var scheduleFlush = undefined;
// Decide what async method to use to triggering processing of queued callbacks:
if (isNode) {
  scheduleFlush = useNextTick();
} else if (BrowserMutationObserver) {
  scheduleFlush = useMutationObserver();
} else if (isWorker) {
  scheduleFlush = useMessageChannel();
} else if (browserWindow === undefined && typeof require === 'function') {
  scheduleFlush = attemptVertx();
} else {
  scheduleFlush = useSetTimeout();
}

function then(onFulfillment, onRejection) {
  var _arguments = arguments;

  var parent = this;

  var child = new this.constructor(noop);

  if (child[PROMISE_ID] === undefined) {
    makePromise(child);
  }

  var _state = parent._state;

  if (_state) {
    (function () {
      var callback = _arguments[_state - 1];
      asap(function () {
        return invokeCallback(_state, child, callback, parent._result);
      });
    })();
  } else {
    subscribe(parent, child, onFulfillment, onRejection);
  }

  return child;
}

/**
  `Promise.resolve` returns a promise that will become resolved with the
  passed `value`. It is shorthand for the following:

  ```javascript
  let promise = new Promise(function(resolve, reject){
    resolve(1);
  });

  promise.then(function(value){
    // value === 1
  });
  ```

  Instead of writing the above, your code now simply becomes the following:

  ```javascript
  let promise = Promise.resolve(1);

  promise.then(function(value){
    // value === 1
  });
  ```

  @method resolve
  @static
  @param {Any} value value that the returned promise will be resolved with
  Useful for tooling.
  @return {Promise} a promise that will become fulfilled with the given
  `value`
*/
function resolve(object) {
  /*jshint validthis:true */
  var Constructor = this;

  if (object && typeof object === 'object' && object.constructor === Constructor) {
    return object;
  }

  var promise = new Constructor(noop);
  _resolve(promise, object);
  return promise;
}

var PROMISE_ID = Math.random().toString(36).substring(16);

function noop() {}

var PENDING = void 0;
var FULFILLED = 1;
var REJECTED = 2;

var GET_THEN_ERROR = new ErrorObject();

function selfFulfillment() {
  return new TypeError("You cannot resolve a promise with itself");
}

function cannotReturnOwn() {
  return new TypeError('A promises callback cannot return that same promise.');
}

function getThen(promise) {
  try {
    return promise.then;
  } catch (error) {
    GET_THEN_ERROR.error = error;
    return GET_THEN_ERROR;
  }
}

function tryThen(then, value, fulfillmentHandler, rejectionHandler) {
  try {
    then.call(value, fulfillmentHandler, rejectionHandler);
  } catch (e) {
    return e;
  }
}

function handleForeignThenable(promise, thenable, then) {
  asap(function (promise) {
    var sealed = false;
    var error = tryThen(then, thenable, function (value) {
      if (sealed) {
        return;
      }
      sealed = true;
      if (thenable !== value) {
        _resolve(promise, value);
      } else {
        fulfill(promise, value);
      }
    }, function (reason) {
      if (sealed) {
        return;
      }
      sealed = true;

      _reject(promise, reason);
    }, 'Settle: ' + (promise._label || ' unknown promise'));

    if (!sealed && error) {
      sealed = true;
      _reject(promise, error);
    }
  }, promise);
}

function handleOwnThenable(promise, thenable) {
  if (thenable._state === FULFILLED) {
    fulfill(promise, thenable._result);
  } else if (thenable._state === REJECTED) {
    _reject(promise, thenable._result);
  } else {
    subscribe(thenable, undefined, function (value) {
      return _resolve(promise, value);
    }, function (reason) {
      return _reject(promise, reason);
    });
  }
}

function handleMaybeThenable(promise, maybeThenable, then$$) {
  if (maybeThenable.constructor === promise.constructor && then$$ === then && maybeThenable.constructor.resolve === resolve) {
    handleOwnThenable(promise, maybeThenable);
  } else {
    if (then$$ === GET_THEN_ERROR) {
      _reject(promise, GET_THEN_ERROR.error);
    } else if (then$$ === undefined) {
      fulfill(promise, maybeThenable);
    } else if (isFunction(then$$)) {
      handleForeignThenable(promise, maybeThenable, then$$);
    } else {
      fulfill(promise, maybeThenable);
    }
  }
}

function _resolve(promise, value) {
  if (promise === value) {
    _reject(promise, selfFulfillment());
  } else if (objectOrFunction(value)) {
    handleMaybeThenable(promise, value, getThen(value));
  } else {
    fulfill(promise, value);
  }
}

function publishRejection(promise) {
  if (promise._onerror) {
    promise._onerror(promise._result);
  }

  publish(promise);
}

function fulfill(promise, value) {
  if (promise._state !== PENDING) {
    return;
  }

  promise._result = value;
  promise._state = FULFILLED;

  if (promise._subscribers.length !== 0) {
    asap(publish, promise);
  }
}

function _reject(promise, reason) {
  if (promise._state !== PENDING) {
    return;
  }
  promise._state = REJECTED;
  promise._result = reason;

  asap(publishRejection, promise);
}

function subscribe(parent, child, onFulfillment, onRejection) {
  var _subscribers = parent._subscribers;
  var length = _subscribers.length;

  parent._onerror = null;

  _subscribers[length] = child;
  _subscribers[length + FULFILLED] = onFulfillment;
  _subscribers[length + REJECTED] = onRejection;

  if (length === 0 && parent._state) {
    asap(publish, parent);
  }
}

function publish(promise) {
  var subscribers = promise._subscribers;
  var settled = promise._state;

  if (subscribers.length === 0) {
    return;
  }

  var child = undefined,
      callback = undefined,
      detail = promise._result;

  for (var i = 0; i < subscribers.length; i += 3) {
    child = subscribers[i];
    callback = subscribers[i + settled];

    if (child) {
      invokeCallback(settled, child, callback, detail);
    } else {
      callback(detail);
    }
  }

  promise._subscribers.length = 0;
}

function ErrorObject() {
  this.error = null;
}

var TRY_CATCH_ERROR = new ErrorObject();

function tryCatch(callback, detail) {
  try {
    return callback(detail);
  } catch (e) {
    TRY_CATCH_ERROR.error = e;
    return TRY_CATCH_ERROR;
  }
}

function invokeCallback(settled, promise, callback, detail) {
  var hasCallback = isFunction(callback),
      value = undefined,
      error = undefined,
      succeeded = undefined,
      failed = undefined;

  if (hasCallback) {
    value = tryCatch(callback, detail);

    if (value === TRY_CATCH_ERROR) {
      failed = true;
      error = value.error;
      value = null;
    } else {
      succeeded = true;
    }

    if (promise === value) {
      _reject(promise, cannotReturnOwn());
      return;
    }
  } else {
    value = detail;
    succeeded = true;
  }

  if (promise._state !== PENDING) {
    // noop
  } else if (hasCallback && succeeded) {
      _resolve(promise, value);
    } else if (failed) {
      _reject(promise, error);
    } else if (settled === FULFILLED) {
      fulfill(promise, value);
    } else if (settled === REJECTED) {
      _reject(promise, value);
    }
}

function initializePromise(promise, resolver) {
  try {
    resolver(function resolvePromise(value) {
      _resolve(promise, value);
    }, function rejectPromise(reason) {
      _reject(promise, reason);
    });
  } catch (e) {
    _reject(promise, e);
  }
}

var id = 0;
function nextId() {
  return id++;
}

function makePromise(promise) {
  promise[PROMISE_ID] = id++;
  promise._state = undefined;
  promise._result = undefined;
  promise._subscribers = [];
}

function Enumerator(Constructor, input) {
  this._instanceConstructor = Constructor;
  this.promise = new Constructor(noop);

  if (!this.promise[PROMISE_ID]) {
    makePromise(this.promise);
  }

  if (isArray(input)) {
    this._input = input;
    this.length = input.length;
    this._remaining = input.length;

    this._result = new Array(this.length);

    if (this.length === 0) {
      fulfill(this.promise, this._result);
    } else {
      this.length = this.length || 0;
      this._enumerate();
      if (this._remaining === 0) {
        fulfill(this.promise, this._result);
      }
    }
  } else {
    _reject(this.promise, validationError());
  }
}

function validationError() {
  return new Error('Array Methods must be provided an Array');
};

Enumerator.prototype._enumerate = function () {
  var length = this.length;
  var _input = this._input;

  for (var i = 0; this._state === PENDING && i < length; i++) {
    this._eachEntry(_input[i], i);
  }
};

Enumerator.prototype._eachEntry = function (entry, i) {
  var c = this._instanceConstructor;
  var resolve$$ = c.resolve;

  if (resolve$$ === resolve) {
    var _then = getThen(entry);

    if (_then === then && entry._state !== PENDING) {
      this._settledAt(entry._state, i, entry._result);
    } else if (typeof _then !== 'function') {
      this._remaining--;
      this._result[i] = entry;
    } else if (c === Promise) {
      var promise = new c(noop);
      handleMaybeThenable(promise, entry, _then);
      this._willSettleAt(promise, i);
    } else {
      this._willSettleAt(new c(function (resolve$$) {
        return resolve$$(entry);
      }), i);
    }
  } else {
    this._willSettleAt(resolve$$(entry), i);
  }
};

Enumerator.prototype._settledAt = function (state, i, value) {
  var promise = this.promise;

  if (promise._state === PENDING) {
    this._remaining--;

    if (state === REJECTED) {
      _reject(promise, value);
    } else {
      this._result[i] = value;
    }
  }

  if (this._remaining === 0) {
    fulfill(promise, this._result);
  }
};

Enumerator.prototype._willSettleAt = function (promise, i) {
  var enumerator = this;

  subscribe(promise, undefined, function (value) {
    return enumerator._settledAt(FULFILLED, i, value);
  }, function (reason) {
    return enumerator._settledAt(REJECTED, i, reason);
  });
};

/**
  `Promise.all` accepts an array of promises, and returns a new promise which
  is fulfilled with an array of fulfillment values for the passed promises, or
  rejected with the reason of the first passed promise to be rejected. It casts all
  elements of the passed iterable to promises as it runs this algorithm.

  Example:

  ```javascript
  let promise1 = resolve(1);
  let promise2 = resolve(2);
  let promise3 = resolve(3);
  let promises = [ promise1, promise2, promise3 ];

  Promise.all(promises).then(function(array){
    // The array here would be [ 1, 2, 3 ];
  });
  ```

  If any of the `promises` given to `all` are rejected, the first promise
  that is rejected will be given as an argument to the returned promises's
  rejection handler. For example:

  Example:

  ```javascript
  let promise1 = resolve(1);
  let promise2 = reject(new Error("2"));
  let promise3 = reject(new Error("3"));
  let promises = [ promise1, promise2, promise3 ];

  Promise.all(promises).then(function(array){
    // Code here never runs because there are rejected promises!
  }, function(error) {
    // error.message === "2"
  });
  ```

  @method all
  @static
  @param {Array} entries array of promises
  @param {String} label optional string for labeling the promise.
  Useful for tooling.
  @return {Promise} promise that is fulfilled when all `promises` have been
  fulfilled, or rejected if any of them become rejected.
  @static
*/
function all(entries) {
  return new Enumerator(this, entries).promise;
}

/**
  `Promise.race` returns a new promise which is settled in the same way as the
  first passed promise to settle.

  Example:

  ```javascript
  let promise1 = new Promise(function(resolve, reject){
    setTimeout(function(){
      resolve('promise 1');
    }, 200);
  });

  let promise2 = new Promise(function(resolve, reject){
    setTimeout(function(){
      resolve('promise 2');
    }, 100);
  });

  Promise.race([promise1, promise2]).then(function(result){
    // result === 'promise 2' because it was resolved before promise1
    // was resolved.
  });
  ```

  `Promise.race` is deterministic in that only the state of the first
  settled promise matters. For example, even if other promises given to the
  `promises` array argument are resolved, but the first settled promise has
  become rejected before the other promises became fulfilled, the returned
  promise will become rejected:

  ```javascript
  let promise1 = new Promise(function(resolve, reject){
    setTimeout(function(){
      resolve('promise 1');
    }, 200);
  });

  let promise2 = new Promise(function(resolve, reject){
    setTimeout(function(){
      reject(new Error('promise 2'));
    }, 100);
  });

  Promise.race([promise1, promise2]).then(function(result){
    // Code here never runs
  }, function(reason){
    // reason.message === 'promise 2' because promise 2 became rejected before
    // promise 1 became fulfilled
  });
  ```

  An example real-world use case is implementing timeouts:

  ```javascript
  Promise.race([ajax('foo.json'), timeout(5000)])
  ```

  @method race
  @static
  @param {Array} promises array of promises to observe
  Useful for tooling.
  @return {Promise} a promise which settles in the same way as the first passed
  promise to settle.
*/
function race(entries) {
  /*jshint validthis:true */
  var Constructor = this;

  if (!isArray(entries)) {
    return new Constructor(function (_, reject) {
      return reject(new TypeError('You must pass an array to race.'));
    });
  } else {
    return new Constructor(function (resolve, reject) {
      var length = entries.length;
      for (var i = 0; i < length; i++) {
        Constructor.resolve(entries[i]).then(resolve, reject);
      }
    });
  }
}

/**
  `Promise.reject` returns a promise rejected with the passed `reason`.
  It is shorthand for the following:

  ```javascript
  let promise = new Promise(function(resolve, reject){
    reject(new Error('WHOOPS'));
  });

  promise.then(function(value){
    // Code here doesn't run because the promise is rejected!
  }, function(reason){
    // reason.message === 'WHOOPS'
  });
  ```

  Instead of writing the above, your code now simply becomes the following:

  ```javascript
  let promise = Promise.reject(new Error('WHOOPS'));

  promise.then(function(value){
    // Code here doesn't run because the promise is rejected!
  }, function(reason){
    // reason.message === 'WHOOPS'
  });
  ```

  @method reject
  @static
  @param {Any} reason value that the returned promise will be rejected with.
  Useful for tooling.
  @return {Promise} a promise rejected with the given `reason`.
*/
function reject(reason) {
  /*jshint validthis:true */
  var Constructor = this;
  var promise = new Constructor(noop);
  _reject(promise, reason);
  return promise;
}

function needsResolver() {
  throw new TypeError('You must pass a resolver function as the first argument to the promise constructor');
}

function needsNew() {
  throw new TypeError("Failed to construct 'Promise': Please use the 'new' operator, this object constructor cannot be called as a function.");
}

/**
  Promise objects represent the eventual result of an asynchronous operation. The
  primary way of interacting with a promise is through its `then` method, which
  registers callbacks to receive either a promise's eventual value or the reason
  why the promise cannot be fulfilled.

  Terminology
  -----------

  - `promise` is an object or function with a `then` method whose behavior conforms to this specification.
  - `thenable` is an object or function that defines a `then` method.
  - `value` is any legal JavaScript value (including undefined, a thenable, or a promise).
  - `exception` is a value that is thrown using the throw statement.
  - `reason` is a value that indicates why a promise was rejected.
  - `settled` the final resting state of a promise, fulfilled or rejected.

  A promise can be in one of three states: pending, fulfilled, or rejected.

  Promises that are fulfilled have a fulfillment value and are in the fulfilled
  state.  Promises that are rejected have a rejection reason and are in the
  rejected state.  A fulfillment value is never a thenable.

  Promises can also be said to *resolve* a value.  If this value is also a
  promise, then the original promise's settled state will match the value's
  settled state.  So a promise that *resolves* a promise that rejects will
  itself reject, and a promise that *resolves* a promise that fulfills will
  itself fulfill.


  Basic Usage:
  ------------

  ```js
  let promise = new Promise(function(resolve, reject) {
    // on success
    resolve(value);

    // on failure
    reject(reason);
  });

  promise.then(function(value) {
    // on fulfillment
  }, function(reason) {
    // on rejection
  });
  ```

  Advanced Usage:
  ---------------

  Promises shine when abstracting away asynchronous interactions such as
  `XMLHttpRequest`s.

  ```js
  function getJSON(url) {
    return new Promise(function(resolve, reject){
      let xhr = new XMLHttpRequest();

      xhr.open('GET', url);
      xhr.onreadystatechange = handler;
      xhr.responseType = 'json';
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.send();

      function handler() {
        if (this.readyState === this.DONE) {
          if (this.status === 200) {
            resolve(this.response);
          } else {
            reject(new Error('getJSON: `' + url + '` failed with status: [' + this.status + ']'));
          }
        }
      };
    });
  }

  getJSON('/posts.json').then(function(json) {
    // on fulfillment
  }, function(reason) {
    // on rejection
  });
  ```

  Unlike callbacks, promises are great composable primitives.

  ```js
  Promise.all([
    getJSON('/posts'),
    getJSON('/comments')
  ]).then(function(values){
    values[0] // => postsJSON
    values[1] // => commentsJSON

    return values;
  });
  ```

  @class Promise
  @param {function} resolver
  Useful for tooling.
  @constructor
*/
function Promise(resolver) {
  this[PROMISE_ID] = nextId();
  this._result = this._state = undefined;
  this._subscribers = [];

  if (noop !== resolver) {
    typeof resolver !== 'function' && needsResolver();
    this instanceof Promise ? initializePromise(this, resolver) : needsNew();
  }
}

Promise.all = all;
Promise.race = race;
Promise.resolve = resolve;
Promise.reject = reject;
Promise._setScheduler = setScheduler;
Promise._setAsap = setAsap;
Promise._asap = asap;

Promise.prototype = {
  constructor: Promise,

  /**
    The primary way of interacting with a promise is through its `then` method,
    which registers callbacks to receive either a promise's eventual value or the
    reason why the promise cannot be fulfilled.
  
    ```js
    findUser().then(function(user){
      // user is available
    }, function(reason){
      // user is unavailable, and you are given the reason why
    });
    ```
  
    Chaining
    --------
  
    The return value of `then` is itself a promise.  This second, 'downstream'
    promise is resolved with the return value of the first promise's fulfillment
    or rejection handler, or rejected if the handler throws an exception.
  
    ```js
    findUser().then(function (user) {
      return user.name;
    }, function (reason) {
      return 'default name';
    }).then(function (userName) {
      // If `findUser` fulfilled, `userName` will be the user's name, otherwise it
      // will be `'default name'`
    });
  
    findUser().then(function (user) {
      throw new Error('Found user, but still unhappy');
    }, function (reason) {
      throw new Error('`findUser` rejected and we're unhappy');
    }).then(function (value) {
      // never reached
    }, function (reason) {
      // if `findUser` fulfilled, `reason` will be 'Found user, but still unhappy'.
      // If `findUser` rejected, `reason` will be '`findUser` rejected and we're unhappy'.
    });
    ```
    If the downstream promise does not specify a rejection handler, rejection reasons will be propagated further downstream.
  
    ```js
    findUser().then(function (user) {
      throw new PedagogicalException('Upstream error');
    }).then(function (value) {
      // never reached
    }).then(function (value) {
      // never reached
    }, function (reason) {
      // The `PedgagocialException` is propagated all the way down to here
    });
    ```
  
    Assimilation
    ------------
  
    Sometimes the value you want to propagate to a downstream promise can only be
    retrieved asynchronously. This can be achieved by returning a promise in the
    fulfillment or rejection handler. The downstream promise will then be pending
    until the returned promise is settled. This is called *assimilation*.
  
    ```js
    findUser().then(function (user) {
      return findCommentsByAuthor(user);
    }).then(function (comments) {
      // The user's comments are now available
    });
    ```
  
    If the assimliated promise rejects, then the downstream promise will also reject.
  
    ```js
    findUser().then(function (user) {
      return findCommentsByAuthor(user);
    }).then(function (comments) {
      // If `findCommentsByAuthor` fulfills, we'll have the value here
    }, function (reason) {
      // If `findCommentsByAuthor` rejects, we'll have the reason here
    });
    ```
  
    Simple Example
    --------------
  
    Synchronous Example
  
    ```javascript
    let result;
  
    try {
      result = findResult();
      // success
    } catch(reason) {
      // failure
    }
    ```
  
    Errback Example
  
    ```js
    findResult(function(result, err){
      if (err) {
        // failure
      } else {
        // success
      }
    });
    ```
  
    Promise Example;
  
    ```javascript
    findResult().then(function(result){
      // success
    }, function(reason){
      // failure
    });
    ```
  
    Advanced Example
    --------------
  
    Synchronous Example
  
    ```javascript
    let author, books;
  
    try {
      author = findAuthor();
      books  = findBooksByAuthor(author);
      // success
    } catch(reason) {
      // failure
    }
    ```
  
    Errback Example
  
    ```js
  
    function foundBooks(books) {
  
    }
  
    function failure(reason) {
  
    }
  
    findAuthor(function(author, err){
      if (err) {
        failure(err);
        // failure
      } else {
        try {
          findBoooksByAuthor(author, function(books, err) {
            if (err) {
              failure(err);
            } else {
              try {
                foundBooks(books);
              } catch(reason) {
                failure(reason);
              }
            }
          });
        } catch(error) {
          failure(err);
        }
        // success
      }
    });
    ```
  
    Promise Example;
  
    ```javascript
    findAuthor().
      then(findBooksByAuthor).
      then(function(books){
        // found books
    }).catch(function(reason){
      // something went wrong
    });
    ```
  
    @method then
    @param {Function} onFulfilled
    @param {Function} onRejected
    Useful for tooling.
    @return {Promise}
  */
  then: then,

  /**
    `catch` is simply sugar for `then(undefined, onRejection)` which makes it the same
    as the catch block of a try/catch statement.
  
    ```js
    function findAuthor(){
      throw new Error('couldn't find that author');
    }
  
    // synchronous
    try {
      findAuthor();
    } catch(reason) {
      // something went wrong
    }
  
    // async with promises
    findAuthor().catch(function(reason){
      // something went wrong
    });
    ```
  
    @method catch
    @param {Function} onRejection
    Useful for tooling.
    @return {Promise}
  */
  'catch': function _catch(onRejection) {
    return this.then(null, onRejection);
  }
};

function polyfill() {
    var local = undefined;

    if (typeof global !== 'undefined') {
        local = global;
    } else if (typeof self !== 'undefined') {
        local = self;
    } else {
        try {
            local = Function('return this')();
        } catch (e) {
            throw new Error('polyfill failed because global object is unavailable in this environment');
        }
    }

    var P = local.Promise;

    if (P) {
        var promiseToString = null;
        try {
            promiseToString = Object.prototype.toString.call(P.resolve());
        } catch (e) {
            // silently ignored
        }

        if (promiseToString === '[object Promise]' && !P.cast) {
            return;
        }
    }

    local.Promise = Promise;
}

polyfill();
// Strange compat..
Promise.polyfill = polyfill;
Promise.Promise = Promise;

return Promise;

})));

}).call(this,require('_process'),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{"_process":16}],14:[function(require,module,exports){
var reDelim = /[\.\:]/;

/**
  # mbus

  If Node's EventEmitter and Eve were to have a child, it might look something like this.
  No wildcard support at this stage though...

  ## Example Usage

  <<< docs/usage.md

  ## Reference

  ### `mbus(namespace?, parent?, scope?)`

  Create a new message bus with `namespace` inheriting from the `parent`
  mbus instance.  If events from this message bus should be triggered with
  a specific `this` scope, then specify it using the `scope` argument.

**/

var createBus = module.exports = function(namespace, parent, scope) {
  var registry = {};
  var feeds = [];

  function bus(name) {
    var args = [].slice.call(arguments, 1);
    var delimited = normalize(name);
    var handlers = registry[delimited] || [];
    var results;

    // send through the feeds
    feeds.forEach(function(feed) {
      feed({ name: delimited, args: args });
    });

    // run the registered handlers
    results = [].concat(handlers).map(function(handler) {
      return handler.apply(scope || this, args);
    });

    // run the parent handlers
    if (bus.parent) {
      results = results.concat(
        bus.parent.apply(
          scope || this,
          [(namespace ? namespace + '.' : '') + delimited].concat(args)
        )
      );
    }

    return results;
  }

  /**
    ### `mbus#clear()`

    Reset the handler registry, which essential deregisters all event listeners.

    _Alias:_ `removeAllListeners`
  **/
  function clear(name) {
    // if we have a name, reset handlers for that handler
    if (name) {
      delete registry[normalize(name)];
    }
    // otherwise, reset the entire handler registry
    else {
      registry = {};
    }
  }

  /**
    ### `mbus#feed(handler)`

    Attach a handler function that will see all events that are sent through
    this bus in an "object stream" format that matches the following format:

    ```
    { name: 'event.name', args: [ 'event', 'args' ] }
    ```

    The feed function returns a function that can be called to stop the feed
    sending data.

  **/
  function feed(handler) {
    function stop() {
      feeds.splice(feeds.indexOf(handler), 1);
    }

    feeds.push(handler);
    return stop;
  }

  function normalize(name) {
    return (Array.isArray(name) ? name : name.split(reDelim)).join('.');
  }

  /**
    ### `mbus#off(name, handler)`

    Deregister an event handler.
  **/
  function off(name, handler) {
    var handlers = registry[normalize(name)] || [];
    var idx = handlers ? handlers.indexOf(handler._actual || handler) : -1;

    if (idx >= 0) {
      handlers.splice(idx, 1);
    }
  }

  /**
    ### `mbus#on(name, handler)`

    Register an event handler for the event `name`.

  **/
  function on(name, handler) {
    var handlers;

    name = normalize(name);
    handlers = registry[name];

    if (handlers) {
      handlers.push(handler);
    }
    else {
      registry[name] = [ handler ];
    }

    return bus;
  }


  /**
    ### `mbus#once(name, handler)`

    Register an event handler for the event `name` that will only
    trigger once (i.e. the handler will be deregistered immediately after
    being triggered the first time).

  **/
  function once(name, handler) {
    function handleEvent() {
      var result = handler.apply(this, arguments);

      bus.off(name, handleEvent);
      return result;
    }

    handler._actual = handleEvent;
    return on(name, handleEvent);
  }

  if (typeof namespace == 'function') {
    parent = namespace;
    namespace = '';
  }

  namespace = normalize(namespace || '');

  bus.clear = bus.removeAllListeners = clear;
  bus.feed = feed;
  bus.on = bus.addListener = on;
  bus.once = once;
  bus.off = bus.removeListener = off;
  bus.parent = parent || (namespace && createBus());

  return bus;
};

},{}],15:[function(require,module,exports){
/**
 * Expose `PriorityQueue`.
 */
module.exports = PriorityQueue;

/**
 * Initializes a new empty `PriorityQueue` with the given `comparator(a, b)`
 * function, uses `.DEFAULT_COMPARATOR()` when no function is provided.
 *
 * The comparator function must return a positive number when `a > b`, 0 when
 * `a == b` and a negative number when `a < b`.
 *
 * @param {Function}
 * @return {PriorityQueue}
 * @api public
 */
function PriorityQueue(comparator) {
  this._comparator = comparator || PriorityQueue.DEFAULT_COMPARATOR;
  this._elements = [];
}

/**
 * Compares `a` and `b`, when `a > b` it returns a positive number, when
 * it returns 0 and when `a < b` it returns a negative number.
 *
 * @param {String|Number} a
 * @param {String|Number} b
 * @return {Number}
 * @api public
 */
PriorityQueue.DEFAULT_COMPARATOR = function(a, b) {
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b;
  } else {
    a = a.toString();
    b = b.toString();

    if (a == b) return 0;

    return (a > b) ? 1 : -1;
  }
};

/**
 * Returns whether the priority queue is empty or not.
 *
 * @return {Boolean}
 * @api public
 */
PriorityQueue.prototype.isEmpty = function() {
  return this.size() === 0;
};

/**
 * Peeks at the top element of the priority queue.
 *
 * @return {Object}
 * @throws {Error} when the queue is empty.
 * @api public
 */
PriorityQueue.prototype.peek = function() {
  if (this.isEmpty()) throw new Error('PriorityQueue is empty');

  return this._elements[0];
};

/**
 * Dequeues the top element of the priority queue.
 *
 * @return {Object}
 * @throws {Error} when the queue is empty.
 * @api public
 */
PriorityQueue.prototype.deq = function() {
  var first = this.peek();
  var last = this._elements.pop();
  var size = this.size();

  if (size === 0) return first;

  this._elements[0] = last;
  var current = 0;

  while (current < size) {
    var largest = current;
    var left = (2 * current) + 1;
    var right = (2 * current) + 2;

    if (left < size && this._compare(left, largest) >= 0) {
      largest = left;
    }

    if (right < size && this._compare(right, largest) >= 0) {
      largest = right;
    }

    if (largest === current) break;

    this._swap(largest, current);
    current = largest;
  }

  return first;
};

/**
 * Enqueues the `element` at the priority queue and returns its new size.
 *
 * @param {Object} element
 * @return {Number}
 * @api public
 */
PriorityQueue.prototype.enq = function(element) {
  var size = this._elements.push(element);
  var current = size - 1;

  while (current > 0) {
    var parent = Math.floor((current - 1) / 2);

    if (this._compare(current, parent) <= 0) break;

    this._swap(parent, current);
    current = parent;
  }

  return size;
};

/**
 * Returns the size of the priority queue.
 *
 * @return {Number}
 * @api public
 */
PriorityQueue.prototype.size = function() {
  return this._elements.length;
};

/**
 *  Iterates over queue elements
 *
 *  @param {Function} fn
 */
PriorityQueue.prototype.forEach = function(fn) {
  return this._elements.forEach(fn);
};

/**
 * Compares the values at position `a` and `b` in the priority queue using its
 * comparator function.
 *
 * @param {Number} a
 * @param {Number} b
 * @return {Number}
 * @api private
 */
PriorityQueue.prototype._compare = function(a, b) {
  return this._comparator(this._elements[a], this._elements[b]);
};

/**
 * Swaps the values at position `a` and `b` in the priority queue.
 *
 * @param {Number} a
 * @param {Number} b
 * @api private
 */
PriorityQueue.prototype._swap = function(a, b) {
  var aux = this._elements[a];
  this._elements[a] = this._elements[b];
  this._elements[b] = aux;
};

},{}],16:[function(require,module,exports){
// shim for using process in browser
var process = module.exports = {};

// cached from whatever global is present so that test runners that stub it
// don't break things.  But we need to wrap it in a try catch in case it is
// wrapped in strict mode code which doesn't define any globals.  It's inside a
// function because try/catches deoptimize in certain engines.

var cachedSetTimeout;
var cachedClearTimeout;

function defaultSetTimout() {
    throw new Error('setTimeout has not been defined');
}
function defaultClearTimeout () {
    throw new Error('clearTimeout has not been defined');
}
(function () {
    try {
        if (typeof setTimeout === 'function') {
            cachedSetTimeout = setTimeout;
        } else {
            cachedSetTimeout = defaultSetTimout;
        }
    } catch (e) {
        cachedSetTimeout = defaultSetTimout;
    }
    try {
        if (typeof clearTimeout === 'function') {
            cachedClearTimeout = clearTimeout;
        } else {
            cachedClearTimeout = defaultClearTimeout;
        }
    } catch (e) {
        cachedClearTimeout = defaultClearTimeout;
    }
} ())
function runTimeout(fun) {
    if (cachedSetTimeout === setTimeout) {
        //normal enviroments in sane situations
        return setTimeout(fun, 0);
    }
    // if setTimeout wasn't available but was latter defined
    if ((cachedSetTimeout === defaultSetTimout || !cachedSetTimeout) && setTimeout) {
        cachedSetTimeout = setTimeout;
        return setTimeout(fun, 0);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedSetTimeout(fun, 0);
    } catch(e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't trust the global object when called normally
            return cachedSetTimeout.call(null, fun, 0);
        } catch(e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error
            return cachedSetTimeout.call(this, fun, 0);
        }
    }


}
function runClearTimeout(marker) {
    if (cachedClearTimeout === clearTimeout) {
        //normal enviroments in sane situations
        return clearTimeout(marker);
    }
    // if clearTimeout wasn't available but was latter defined
    if ((cachedClearTimeout === defaultClearTimeout || !cachedClearTimeout) && clearTimeout) {
        cachedClearTimeout = clearTimeout;
        return clearTimeout(marker);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedClearTimeout(marker);
    } catch (e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't  trust the global object when called normally
            return cachedClearTimeout.call(null, marker);
        } catch (e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error.
            // Some versions of I.E. have different rules for clearTimeout vs setTimeout
            return cachedClearTimeout.call(this, marker);
        }
    }



}
var queue = [];
var draining = false;
var currentQueue;
var queueIndex = -1;

function cleanUpNextTick() {
    if (!draining || !currentQueue) {
        return;
    }
    draining = false;
    if (currentQueue.length) {
        queue = currentQueue.concat(queue);
    } else {
        queueIndex = -1;
    }
    if (queue.length) {
        drainQueue();
    }
}

function drainQueue() {
    if (draining) {
        return;
    }
    var timeout = runTimeout(cleanUpNextTick);
    draining = true;

    var len = queue.length;
    while(len) {
        currentQueue = queue;
        queue = [];
        while (++queueIndex < len) {
            if (currentQueue) {
                currentQueue[queueIndex].run();
            }
        }
        queueIndex = -1;
        len = queue.length;
    }
    currentQueue = null;
    draining = false;
    runClearTimeout(timeout);
}

process.nextTick = function (fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
        for (var i = 1; i < arguments.length; i++) {
            args[i - 1] = arguments[i];
        }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
        runTimeout(drainQueue);
    }
};

// v8 likes predictible objects
function Item(fun, array) {
    this.fun = fun;
    this.array = array;
}
Item.prototype.run = function () {
    this.fun.apply(null, this.array);
};
process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];
process.version = ''; // empty string to avoid regexp issues
process.versions = {};

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;

process.binding = function (name) {
    throw new Error('process.binding is not supported');
};

process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};
process.umask = function() { return 0; };

},{}],17:[function(require,module,exports){
/**
  ### `reu/ip`

  A regular expression that will match both IPv4 and IPv6 addresses.  This is a modified
  regex (remove hostname matching) that was implemented by @Mikulas in
  [this stackoverflow answer](http://stackoverflow.com/a/9209720/96656).

**/
module.exports = /^(([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])\.){3}([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$|^(?:(?:(?:(?:(?:(?:(?:[0-9a-fA-F]{1,4})):){6})(?:(?:(?:(?:(?:[0-9a-fA-F]{1,4})):(?:(?:[0-9a-fA-F]{1,4})))|(?:(?:(?:(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9]))\.){3}(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9])))))))|(?:(?:::(?:(?:(?:[0-9a-fA-F]{1,4})):){5})(?:(?:(?:(?:(?:[0-9a-fA-F]{1,4})):(?:(?:[0-9a-fA-F]{1,4})))|(?:(?:(?:(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9]))\.){3}(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9])))))))|(?:(?:(?:(?:(?:[0-9a-fA-F]{1,4})))?::(?:(?:(?:[0-9a-fA-F]{1,4})):){4})(?:(?:(?:(?:(?:[0-9a-fA-F]{1,4})):(?:(?:[0-9a-fA-F]{1,4})))|(?:(?:(?:(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9]))\.){3}(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9])))))))|(?:(?:(?:(?:(?:(?:[0-9a-fA-F]{1,4})):){0,1}(?:(?:[0-9a-fA-F]{1,4})))?::(?:(?:(?:[0-9a-fA-F]{1,4})):){3})(?:(?:(?:(?:(?:[0-9a-fA-F]{1,4})):(?:(?:[0-9a-fA-F]{1,4})))|(?:(?:(?:(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9]))\.){3}(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9])))))))|(?:(?:(?:(?:(?:(?:[0-9a-fA-F]{1,4})):){0,2}(?:(?:[0-9a-fA-F]{1,4})))?::(?:(?:(?:[0-9a-fA-F]{1,4})):){2})(?:(?:(?:(?:(?:[0-9a-fA-F]{1,4})):(?:(?:[0-9a-fA-F]{1,4})))|(?:(?:(?:(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9]))\.){3}(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9])))))))|(?:(?:(?:(?:(?:(?:[0-9a-fA-F]{1,4})):){0,3}(?:(?:[0-9a-fA-F]{1,4})))?::(?:(?:[0-9a-fA-F]{1,4})):)(?:(?:(?:(?:(?:[0-9a-fA-F]{1,4})):(?:(?:[0-9a-fA-F]{1,4})))|(?:(?:(?:(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9]))\.){3}(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9])))))))|(?:(?:(?:(?:(?:(?:[0-9a-fA-F]{1,4})):){0,4}(?:(?:[0-9a-fA-F]{1,4})))?::)(?:(?:(?:(?:(?:[0-9a-fA-F]{1,4})):(?:(?:[0-9a-fA-F]{1,4})))|(?:(?:(?:(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9]))\.){3}(?:(?:25[0-5]|(?:[1-9]|1[0-9]|2[0-4])?[0-9])))))))|(?:(?:(?:(?:(?:(?:[0-9a-fA-F]{1,4})):){0,5}(?:(?:[0-9a-fA-F]{1,4})))?::)(?:(?:[0-9a-fA-F]{1,4})))|(?:(?:(?:(?:(?:(?:[0-9a-fA-F]{1,4})):){0,6}(?:(?:[0-9a-fA-F]{1,4})))?::))))$/;

},{}],18:[function(require,module,exports){
/* jshint node: true */
/* global window: false */
/* global navigator: false */

'use strict';

var browser = require('detect-browser');

/**
  ### `rtc-core/detect`

  A browser detection helper for accessing prefix-free versions of the various
  WebRTC types.

  ### Example Usage

  If you wanted to get the native `RTCPeerConnection` prototype in any browser
  you could do the following:

  ```js
  var detect = require('rtc-core/detect'); // also available in rtc/detect
  var RTCPeerConnection = detect('RTCPeerConnection');
  ```

  This would provide whatever the browser prefixed version of the
  RTCPeerConnection is available (`webkitRTCPeerConnection`,
  `mozRTCPeerConnection`, etc).
**/
var detect = module.exports = function(target, opts) {
  var attach = (opts || {}).attach;
  var prefixIdx;
  var prefix;
  var testName;
  var hostObject = this || (typeof window != 'undefined' ? window : undefined);

  // initialise to default prefixes
  // (reverse order as we use a decrementing for loop)
  var prefixes = ((opts || {}).prefixes || ['ms', 'o', 'moz', 'webkit']).concat('');

  // if we have no host object, then abort
  if (! hostObject) {
    return;
  }

  // iterate through the prefixes and return the class if found in global
  for (prefixIdx = prefixes.length; prefixIdx--; ) {
    prefix = prefixes[prefixIdx];

    // construct the test class name
    // if we have a prefix ensure the target has an uppercase first character
    // such that a test for getUserMedia would result in a
    // search for webkitGetUserMedia
    testName = prefix + (prefix ?
                            target.charAt(0).toUpperCase() + target.slice(1) :
                            target);

    if (typeof hostObject[testName] != 'undefined') {
      // update the last used prefix
      detect.browser = detect.browser || prefix.toLowerCase();

      if (attach) {
         hostObject[target] = hostObject[testName];
      }

      return hostObject[testName];
    }
  }
};

// detect mozilla (yes, this feels dirty)
detect.moz = typeof navigator != 'undefined' && !!navigator.mozGetUserMedia;

// set the browser and browser version
detect.browser = browser.name;
detect.browserVersion = detect.version = browser.version;

},{"detect-browser":11}],19:[function(require,module,exports){
/**
  ### `rtc-core/genice`

  Respond appropriately to options that are passed to packages like
  `rtc-quickconnect` and trigger a `callback` (error first) with iceServer
  values.

  The function looks for either of the following keys in the options, in
  the following order or precedence:

  1. `ice` - this can either be an array of ice server values or a generator
     function (in the same format as this function).  If this key contains a
     value then any servers specified in the `iceServers` key (2) will be
     ignored.

  2. `iceServers` - an array of ice server values.
**/
module.exports = function(opts, callback) {
  var ice = (opts || {}).ice;
  var iceServers = (opts || {}).iceServers;

  if (typeof ice == 'function') {
    return ice(opts, callback);
  }
  else if (Array.isArray(ice)) {
    return callback(null, [].concat(ice));
  }

  callback(null, [].concat(iceServers || []));
};

},{}],20:[function(require,module,exports){
var detect = require('./detect');
var requiredFunctions = [
  'init'
];

function isSupported(plugin) {
  return plugin && typeof plugin.supported == 'function' && plugin.supported(detect);
}

function isValid(plugin) {
  var supportedFunctions = requiredFunctions.filter(function(fn) {
    return typeof plugin[fn] == 'function';
  });

  return supportedFunctions.length === requiredFunctions.length;
}

module.exports = function(plugins) {
  return [].concat(plugins || []).filter(isSupported).filter(isValid)[0];
}

},{"./detect":18}],21:[function(require,module,exports){
/* jshint node: true */
'use strict';

var nub = require('whisk/nub');
var pluck = require('whisk/pluck');
var flatten = require('whisk/flatten');
var reLineBreak = /\r?\n/;
var reTrailingNewlines = /\r?\n$/;

// list sdp line types that are not "significant"
var nonHeaderLines = [ 'a', 'c', 'b', 'k' ];
var parsers = require('./parsers');

/**
  # rtc-sdp

  This is a utility module for intepreting and patching sdp.

  ## Usage

  The `rtc-sdp` main module exposes a single function that is capable of
  parsing lines of SDP, and providing an object allowing you to perform
  operations on those parsed lines:

  ```js
  var sdp = require('rtc-sdp')(lines);
  ```

  The currently supported operations are listed below:

**/
module.exports = function(sdp) {
  var ops = {};
  var parsed = [];
  var activeCollector;

  // initialise the lines
  var lines = sdp.split(reLineBreak).filter(Boolean).map(function(line) {
    return line.split('=');
  });

  var inputOrder = nub(lines.filter(function(line) {
    return line[0] && nonHeaderLines.indexOf(line[0]) < 0;
  }).map(pluck(0)));

  var findLine = ops.findLine = function(type, index) {
    var lineData = parsed.filter(function(line) {
      return line[0] === type;
    })[index || 0];

    return lineData && lineData[1];
  };

  // push into parsed sections
  lines.forEach(function(line) {
    var customParser = parsers[line[0]];

    if (customParser) {
      activeCollector = customParser(parsed, line);
    }
    else if (activeCollector) {
      activeCollector = activeCollector(line);
    }
    else {
      parsed.push(line);
    }
  });

  /**
    ### `sdp.addIceCandidate(data)`

    Modify the sdp to include candidates as denoted by the data.

**/
  ops.addIceCandidate = function(data) {
    var lineIndex = (data || {}).lineIndex || (data || {}).sdpMLineIndex;
    var mLine = typeof lineIndex != 'undefined' && findLine('m', lineIndex);
    var candidate = (data || {}).candidate;

    // if we have the mLine add the new candidate
    if (mLine && candidate) {
      mLine.childlines.push(candidate.replace(reTrailingNewlines, '').split('='));
    }
  };

  /**
    ### `sdp.getMediaTypes() => []`

    Retrieve the list of media types that have been defined in the sdp via
    `m=` lines.
  **/
  ops.getMediaTypes = function() {
    function getMediaType(data) {
      return data[1].def.split(/\s/)[0];
    }

    return parsed.filter(function(parts) {
      return parts[0] === 'm' && parts[1] && parts[1].def;
    }).map(getMediaType);
  };

  /**
    ### `sdp.getMediaIDs() => []`

    Returns the list of unique media line IDs that have been defined in the sdp
    via `a=mid:` lines.
   **/
  ops.getMediaIDs = function() {
    return parsed.filter(function(parts) {
      return parts[0] === 'm' && parts[1] && parts[1].childlines && parts[1].childlines.length > 0;
    }).map(function(mediaLine) {
      var lines = mediaLine[1].childlines;
      // Default ID to the media type
      var mediaId = mediaLine[1].def.split(/\s/)[0];

      // Look for the media ID
      for (var i = 0; i < lines.length; i++) {
        var tokens = lines[i][1].split(':');
        if (tokens.length > 0 && tokens[0] === 'mid') {
          mediaId = tokens[1];
          break;
        }
      }
      return mediaId;
    });
  };

  /**
    ### `sdp.toString()`

    Convert the SDP structure that is currently retained in memory, into a string
    that can be provided to a `setLocalDescription` (or `setRemoteDescription`)
    WebRTC call.

  **/
  ops.toString = function() {
    return parsed.map(function(line) {
      return typeof line[1].toArray == 'function' ? line[1].toArray() : [ line ];
    }).reduce(flatten).map(function(line) {
      return line.join('=');
    }).join('\r\n') + '\r\n';
  };

  /**
    ## SDP Filtering / Munging Functions

    There are additional functions included in the module to assign with
    performing "single-shot" SDP filtering (or munging) operations:

  **/

  return ops;
};

},{"./parsers":22,"whisk/flatten":33,"whisk/nub":35,"whisk/pluck":36}],22:[function(require,module,exports){
/* jshint node: true */
'use strict';

exports.m = function(parsed, line) {
  var media = {
    def: line[1],
    childlines: [],

    toArray: function() {
      return [
        ['m', media.def ]
      ].concat(media.childlines);
    }
  };

  function addChildLine(childLine) {
    media.childlines.push(childLine);
    return addChildLine;
  }

  parsed.push([ 'm', media ]);

  return addChildLine;
};
},{}],23:[function(require,module,exports){
var validators = [
  [ /^(a\=candidate.*)$/, require('rtc-validator/candidate') ]
];

var reSdpLineBreak = /(\r?\n|\\r\\n)/;

/**
  # rtc-sdpclean

  Remove invalid lines from your SDP.

  ## Why?

  This module removes the occasional "bad egg" that will slip into SDP when it
  is generated by the browser.  In particular these situations are catered for:

  - invalid ICE candidates

**/
module.exports = function(input, opts) {
  var lineBreak = detectLineBreak(input);
  var lines = input.split(lineBreak);
  var collector = (opts || {}).collector;

  // filter out invalid lines
  lines = lines.filter(function(line) {
    // iterate through the validators and use the one that matches
    var validator = validators.reduce(function(memo, data, idx) {
      return typeof memo != 'undefined' ? memo : (data[0].exec(line) && {
        line: line.replace(data[0], '$1'),
        fn: data[1]
      });
    }, undefined);

    // if we have a validator, ensure we have no errors
    var errors = validator ? validator.fn(validator.line) : [];

    // if we have errors and an error collector, then add to the collector
    if (collector) {
      errors.forEach(function(err) {
        collector.push(err);
      });
    }

    return errors.length === 0;
  });

  return lines.join(lineBreak);
};

function detectLineBreak(input) {
  var match = reSdpLineBreak.exec(input);

  return match && match[0];
}

},{"rtc-validator/candidate":31}],24:[function(require,module,exports){
var detect = require('rtc-core/detect');
var findPlugin = require('rtc-core/plugin');
var PriorityQueue = require('priorityqueuejs');
var Promise = require('es6-promise').Promise;
var pluck = require('whisk/pluck');
var pluckSessionDesc = pluck('sdp', 'type');

// some validation routines
var checkCandidate = require('rtc-validator/candidate');

// the sdp cleaner
var sdpclean = require('rtc-sdpclean');
var parseSdp = require('rtc-sdp');

var PRIORITY_LOW = 100;
var PRIORITY_WAIT = 1000;

// priority order (lower is better)
var DEFAULT_PRIORITIES = [
  'createOffer',
  'setLocalDescription',
  'createAnswer',
  'setRemoteDescription',
  'addIceCandidate'
];

// define event mappings
var METHOD_EVENTS = {
  setLocalDescription: 'setlocaldesc',
  setRemoteDescription: 'setremotedesc',
  createOffer: 'offer',
  createAnswer: 'answer'
};

var MEDIA_MAPPINGS = {
  data: 'application'
};

// define states in which we will attempt to finalize a connection on receiving a remote offer
var VALID_RESPONSE_STATES = ['have-remote-offer', 'have-local-pranswer'];

/**
  Allows overriding of a function
 **/
function pluggable(pluginFn, defaultFn) {
  return (pluginFn && typeof pluginFn == 'function' ? pluginFn : defaultFn);
}

/**
  # rtc-taskqueue

  This is a package that assists with applying actions to an `RTCPeerConnection`
  in as reliable order as possible. It is primarily used by the coupling logic
  of the [`rtc-tools`](https://github.com/rtc-io/rtc-tools).

  ## Example Usage

  For the moment, refer to the simple coupling test as an example of how to use
  this package (see below):

  <<< test/couple.js

**/
module.exports = function(pc, opts) {
  opts = opts || {};
  // create the task queue
  var queue = new PriorityQueue(orderTasks);
  var tq = require('mbus')('', (opts || {}).logger);

  // initialise task importance
  var priorities = (opts || {}).priorities || DEFAULT_PRIORITIES;
  var queueInterval = (opts || {}).interval || 10;

  // check for plugin usage
  var plugin = findPlugin((opts || {}).plugins);

  // initialise state tracking
  var checkQueueTimer = 0;
  var defaultFail = tq.bind(tq, 'fail');

  // look for an sdpfilter function (allow slight mis-spellings)
  var sdpFilter = (opts || {}).sdpfilter || (opts || {}).sdpFilter;
  var alwaysParse = (opts.sdpParseMode === 'always');

  // initialise session description and icecandidate objects
  var RTCSessionDescription = (opts || {}).RTCSessionDescription ||
    detect('RTCSessionDescription');

  var RTCIceCandidate = (opts || {}).RTCIceCandidate ||
    detect('RTCIceCandidate');

  // Determine plugin overridable methods
  var createIceCandidate = pluggable(plugin && plugin.createIceCandidate, function(data) {
    return new RTCIceCandidate(data);
  });

  var createSessionDescription = pluggable(plugin && plugin.createSessionDescription, function(data) {
    return new RTCSessionDescription(data);
  });

  var qid = tq._qid = Math.floor(Math.random() * 100000);

  function abortQueue(err) {
    console.error(err);
  }

  function applyCandidate(task, next) {
    var data = task.args[0];
    // Allow selective filtering of ICE candidates
    if (opts && opts.filterCandidate && !opts.filterCandidate(data)) {
      tq('ice.remote.filtered', candidate);
      return next();
    }
    var candidate = data && data.candidate && createIceCandidate(data);

    function handleOk() {
      tq('ice.remote.applied', candidate);
      next();
    }

    function handleFail(err) {
      tq('ice.remote.invalid', candidate);
      next(err);
    }

    // we have a null candidate, we have finished gathering candidates
    if (! candidate) {
      return next();
    }

    pc.addIceCandidate(candidate, handleOk, handleFail);
  }

  function checkQueue() {
    // peek at the next item on the queue
    var next = (! queue.isEmpty()) && queue.peek();
    var ready = next && testReady(next);

    // reset the queue timer
    checkQueueTimer = 0;

    // if we don't have a task ready, then abort
    if (! ready) {
      // if we have a task and it has expired then dequeue it
      if (next && (aborted(next) || expired(next))) {
        tq('task.expire', next);
        queue.deq();
      }

      return (! queue.isEmpty()) && isNotClosed(pc) && triggerQueueCheck();
    }

    // properly dequeue task
    next = queue.deq();

    // process the task
    next.fn(next, function(err) {
      var fail = next.fail || defaultFail;
      var pass = next.pass;
      var taskName = next.name;

      // if errored, fail
      if (err) {
        console.error(taskName + ' task failed: ', err);
        return fail(err);
      }

      if (typeof pass == 'function') {
        pass.apply(next, [].slice.call(arguments, 1));
      }

      // Allow tasks to indicate that processing should continue immediately to the
      // following task
      if (next.immediate) {
        if (checkQueueTimer) clearTimeout(checkQueueTimer);
        return checkQueue();
      } else {
        triggerQueueCheck();
      }
    });
  }

  function cleansdp(desc) {
    // ensure we have clean sdp
    var sdpErrors = [];
    var sdp = desc && sdpclean(desc.sdp, { collector: sdpErrors });

    // if we don't have a match, log some info
    if (desc && sdp !== desc.sdp) {
      console.info('invalid lines removed from sdp: ', sdpErrors);
      desc.sdp = sdp;
    }

    // if a filter has been specified, then apply the filter
    if (typeof sdpFilter == 'function') {
      desc.sdp = sdpFilter(desc.sdp, pc);
    }

    return desc;
  }

  function completeConnection() {
    // Clean any cached media types now that we have potentially new remote description
    if (pc.__mediaIDs || pc.__mediaTypes) {
      // Set defined as opposed to delete, for compatibility purposes
      pc.__mediaIDs = undefined;
      pc.__mediaTypes = undefined;
    }

    if (VALID_RESPONSE_STATES.indexOf(pc.signalingState) >= 0) {
      return tq.createAnswer();
    }
  }

  function emitSdp() {
    tq('sdp.local', pluckSessionDesc(this.args[0]));
  }

  function enqueue(name, handler, opts) {
    return function() {
      var args = [].slice.call(arguments);

      if (opts && typeof opts.processArgs == 'function') {
        args = args.map(opts.processArgs);
      }

      var priority = priorities.indexOf(name);

      return new Promise(function(resolve, reject) {
          queue.enq({
          args: args,
          name: name,
          fn: handler,
          priority: priority >= 0 ? priority : PRIORITY_LOW,
          immediate: opts.immediate,
          // If aborted, the task will be removed
          aborted: false,

          // record the time at which the task was queued
          start: Date.now(),

          // initilaise any checks that need to be done prior
          // to the task executing
          checks: [ isNotClosed ].concat((opts || {}).checks || []),

          // initialise the pass and fail handlers
          pass: function() {
            if (opts && opts.pass) {
              opts.pass.apply(this, arguments);
            }
            resolve();
          },
          fail: function() {
            if (opts && opts.fail) {
              opts.fail.apply(this, arguments);
            }
            reject();
          }
        });

        triggerQueueCheck();
      });
    };
  }

  function execMethod(task, next) {
    var fn = pc[task.name];
    var eventName = METHOD_EVENTS[task.name] || (task.name || '').toLowerCase();
    var cbArgs = [ success, fail ];
    var isOffer = task.name === 'createOffer';

    function fail(err) {
      tq.apply(tq, [ 'negotiate.error', task.name, err ].concat(task.args));
      next(err);
    }

    function success() {
      tq.apply(tq, [ ['negotiate', eventName, 'ok'], task.name ].concat(task.args));
      next.apply(null, [null].concat([].slice.call(arguments)));
    }

    if (! fn) {
      return next(new Error('cannot call "' + task.name + '" on RTCPeerConnection'));
    }

    // invoke the function
    tq.apply(tq, ['negotiate.' + eventName].concat(task.args));
    fn.apply(
      pc,
      task.args.concat(cbArgs).concat(isOffer ? generateConstraints() : [])
    );
  }

  function expired(task) {
    return (typeof task.ttl == 'number') && (task.start + task.ttl < Date.now());
  }

  function aborted(task) {
    return task && task.aborted;
  }

  function extractCandidateEventData(data) {
    // extract nested candidate data (like we will see in an event being passed to this function)
    while (data && data.candidate && data.candidate.candidate) {
      data = data.candidate;
    }

    return data;
  }

  function generateConstraints() {
    var allowedKeys = {
      offertoreceivevideo: 'OfferToReceiveVideo',
      offertoreceiveaudio: 'OfferToReceiveAudio',
      icerestart: 'IceRestart',
      voiceactivitydetection: 'VoiceActivityDetection'
    };

    var constraints = {
      OfferToReceiveVideo: true,
      OfferToReceiveAudio: true
    };

    // Handle mozillas slightly different constraint requirements that are
    // enforced as of FF43
    if (detect.moz) {
      allowedKeys = {
        offertoreceivevideo: 'offerToReceiveVideo',
        offertoreceiveaudio: 'offerToReceiveAudio',
        icerestart: 'iceRestart',
        voiceactivitydetection: 'voiceActivityDetection'
      };
      constraints = {
        offerToReceiveVideo: true,
        offerToReceiveAudio: true
      };
    }

    // update known keys to match
    Object.keys(opts || {}).forEach(function(key) {
      if (allowedKeys[key.toLowerCase()]) {
        constraints[allowedKeys[key.toLowerCase()]] = opts[key];
      }
    });

    return (detect.moz ? constraints : { mandatory: constraints });
  }

  function hasLocalOrRemoteDesc(pc, task) {
    return pc.__hasDesc || (pc.__hasDesc = !!pc.remoteDescription);
  }

  function isNotNegotiating(pc) {
    return pc.signalingState !== 'have-local-offer';
  }

  function isNotClosed(pc) {
    return pc.signalingState !== 'closed';
  }

  function isStable(pc) {
    return pc.signalingState === 'stable';
  }

  function isValidCandidate(pc, data) {
    var validCandidate = (data.__valid ||
      (data.__valid = checkCandidate(data.args[0]).length === 0));

    // If the candidate is not valid, abort
    if (!validCandidate) {
      data.aborted = true;
    }
    return validCandidate;
  }

  function isConnReadyForCandidate(pc, data) {
    var sdpMid = data.args[0] && data.args[0].sdpMid;

    // remap media types as appropriate
    sdpMid = MEDIA_MAPPINGS[sdpMid] || sdpMid;

    if (sdpMid === '')
      return true;

    // Allow parsing of SDP always if required
    if (alwaysParse || !pc.__mediaTypes) {
      var sdp = parseSdp(pc.remoteDescription && pc.remoteDescription.sdp);
      // We only want to cache the SDP media types if we've received them, otherwise
      // bad things can happen
      var mediaTypes = sdp.getMediaTypes();
      if (mediaTypes && mediaTypes.length > 0) {
        pc.__mediaTypes = mediaTypes;
      }
      // Same for media IDs
      var mediaIDs = sdp.getMediaIDs();
      if (mediaIDs && mediaIDs.length > 0) {
        pc.__mediaIDs = mediaIDs;
      }
    }
    // the candidate is valid if the sdpMid matches either a known media
    // type, or media ID
    var validMediaCandidate =
      (pc.__mediaIDs && pc.__mediaIDs.indexOf(sdpMid) >= 0) ||
      (pc.__mediaTypes && pc.__mediaTypes.indexOf(sdpMid) >= 0);

    // Otherwise we abort the task
    if (!validMediaCandidate) {
      data.aborted = true;
    }
    return validMediaCandidate;
  }

  function orderTasks(a, b) {
    // apply each of the checks for each task
    var tasks = [a,b];
    var readiness = tasks.map(testReady);
    var taskPriorities = tasks.map(function(task, idx) {
      var ready = readiness[idx];
      return ready ? task.priority : PRIORITY_WAIT;
    });

    return taskPriorities[1] - taskPriorities[0];
  }

  // check whether a task is ready (does it pass all the checks)
  function testReady(task) {
    return (task.checks || []).reduce(function(memo, check) {
      return memo && check(pc, task);
    }, true);
  }

  function triggerQueueCheck() {
    if (checkQueueTimer) return;
    checkQueueTimer = setTimeout(checkQueue, queueInterval);
  }

  // patch in the queue helper methods
  tq.addIceCandidate = enqueue('addIceCandidate', applyCandidate, {
    processArgs: extractCandidateEventData,
    checks: [hasLocalOrRemoteDesc, isValidCandidate, isConnReadyForCandidate ],

    // set ttl to 5s
    ttl: 5000,
    immediate: true
  });

  tq.setLocalDescription = enqueue('setLocalDescription', execMethod, {
    processArgs: cleansdp,
    pass: emitSdp
  });

  tq.setRemoteDescription = enqueue('setRemoteDescription', execMethod, {
    processArgs: createSessionDescription,
    pass: completeConnection
  });

  tq.createOffer = enqueue('createOffer', execMethod, {
    checks: [ isNotNegotiating ],
    pass: tq.setLocalDescription
  });

  tq.createAnswer = enqueue('createAnswer', execMethod, {
    pass: tq.setLocalDescription
  });

  return tq;
};

},{"es6-promise":13,"mbus":14,"priorityqueuejs":15,"rtc-core/detect":18,"rtc-core/plugin":20,"rtc-sdp":21,"rtc-sdpclean":23,"rtc-validator/candidate":31,"whisk/pluck":36}],25:[function(require,module,exports){
/* jshint node: true */
'use strict';

var debug = require('cog/logger')('rtc/cleanup');

var CANNOT_CLOSE_STATES = [
  'closed'
];

var EVENTS_DECOUPLE_BC = [
  'addstream',
  'datachannel',
  'icecandidate',
  'negotiationneeded',
  'removestream',
  'signalingstatechange'
];

var EVENTS_DECOUPLE_AC = [
  'iceconnectionstatechange'
];

/**
  ### rtc-tools/cleanup

  ```
  cleanup(pc)
  ```

  The `cleanup` function is used to ensure that a peer connection is properly
  closed and ready to be cleaned up by the browser.

**/
module.exports = function(pc) {
  if (!pc) return;

  // see if we can close the connection
  var currentState = pc.iceConnectionState;
  var currentSignaling = pc.signalingState;
  var canClose = CANNOT_CLOSE_STATES.indexOf(currentState) < 0 && CANNOT_CLOSE_STATES.indexOf(currentSignaling) < 0;

  function decouple(events) {
    events.forEach(function(evtName) {
      if (pc['on' + evtName]) {
        pc['on' + evtName] = null;
      }
    });
  }

  // decouple "before close" events
  decouple(EVENTS_DECOUPLE_BC);

  if (canClose) {
    debug('attempting connection close, current state: '+ pc.iceConnectionState);
    try {
      pc.close();
    } catch (e) {
      console.warn('Could not close connection', e);
    }
  }

  // remove the event listeners
  // after a short delay giving the connection time to trigger
  // close and iceconnectionstatechange events
  setTimeout(function() {
    decouple(EVENTS_DECOUPLE_AC);
  }, 100);
};

},{"cog/logger":9}],26:[function(require,module,exports){
/* jshint node: true */
'use strict';

var mbus = require('mbus');
var queue = require('rtc-taskqueue');
var cleanup = require('./cleanup');
var monitor = require('./monitor');
var throttle = require('cog/throttle');
var pluck = require('whisk/pluck');
var pluckCandidate = pluck('candidate', 'sdpMid', 'sdpMLineIndex');
var CLOSED_STATES = [ 'closed', 'failed' ];
var CHECKING_STATES = [ 'checking' ];

/**
  ### rtc-tools/couple

  #### couple(pc, targetId, signaller, opts?)

  Couple a WebRTC connection with another webrtc connection identified by
  `targetId` via the signaller.

  The following options can be provided in the `opts` argument:

  - `sdpfilter` (default: null)

    A simple function for filtering SDP as part of the peer
    connection handshake (see the Using Filters details below).

  ##### Example Usage

  ```js
  var couple = require('rtc/couple');

  couple(pc, '54879965-ce43-426e-a8ef-09ac1e39a16d', signaller);
  ```

  ##### Using Filters

  In certain instances you may wish to modify the raw SDP that is provided
  by the `createOffer` and `createAnswer` calls.  This can be done by passing
  a `sdpfilter` function (or array) in the options.  For example:

  ```js
  // run the sdp from through a local tweakSdp function.
  couple(pc, '54879965-ce43-426e-a8ef-09ac1e39a16d', signaller, {
    sdpfilter: tweakSdp
  });
  ```

**/
function couple(pc, targetId, signaller, opts) {
  var debugLabel = (opts || {}).debugLabel || 'rtc';
  var debug = require('cog/logger')(debugLabel + '/couple');

  // create a monitor for the connection
  var mon = monitor(pc, targetId, signaller, (opts || {}).logger);
  var emit = mbus('', mon);
  var reactive = (opts || {}).reactive;
  var endOfCandidates = true;

  // configure the time to wait between receiving a 'disconnect'
  // iceConnectionState and determining that we are closed
  var disconnectTimeout = (opts || {}).disconnectTimeout || 10000;
  var disconnectTimer;

  // Target ready indicates that the target peer has indicated it is
  // ready to begin coupling
  var targetReady = false;
  var targetInfo = undefined;
  var readyInterval = (opts || {}).readyInterval || 100;
  var readyTimer;

  // Failure timeout
  var failTimeout = (opts || {}).failTimeout || 30000;
  var failTimer;

  // Request offer timer
  var requestOfferTimer;

  // Interoperability flags
  var allowReactiveInterop = (opts || {}).allowReactiveInterop;

  // initilaise the negotiation helpers
  var isMaster = signaller.isMaster(targetId);

  // initialise the processing queue (one at a time please)
  var q = queue(pc, opts);
  var coupling = false;
  var negotiationRequired = false;
  var renegotiateRequired = false;
  var creatingOffer = false;
  var interoperating = false;

  /**
    Indicates whether this peer connection is in a state where it is able to have new offers created
   **/
  function isReadyForOffer() {
    return !coupling && pc.signalingState === 'stable';
  }

  function createOffer() {
    // If coupling is already in progress, return
    if (!isReadyForOffer()) return;

    debug('[' + signaller.id + '] ' + 'Creating new offer for connection to ' + targetId);
    // Otherwise, create the offer
    coupling = true;
    creatingOffer = true;
    negotiationRequired = false;
    q.createOffer().then(function() {
      creatingOffer = false;
    }).catch(function() {
      creatingOffer = false;
    });
  }

  var createOrRequestOffer = throttle(function() {
    if (!targetReady) {
      debug('[' + signaller.id + '] ' + targetId + ' not yet ready for offer');
      return emit.once('target.ready', createOrRequestOffer);
    }

    // If this is not the master, always send the negotiate request
    // Redundant requests are eliminated on the master side
    if (! isMaster) {
      debug('[' + signaller.id + '] ' + 'Requesting negotiation from ' + targetId + ' (requesting offerer? ' + renegotiateRequired + ')');
      // Due to https://bugs.chromium.org/p/webrtc/issues/detail?id=2782 which involves incompatibilities between
      // Chrome and Firefox created offers by default client offers are disabled to ensure that all offers are coming
      // from the same source. By passing `allowReactiveInterop` you can reallow this, then use the `filtersdp` option
      // to provide a munged SDP that might be able to work
      return signaller.to(targetId).send('/negotiate', {
        requestOfferer: (allowReactiveInterop || !interoperating) && renegotiateRequired
      });
    }

    return createOffer();
  }, 100, { leading: false });

  function decouple() {
    debug('decoupling ' + signaller.id + ' from ' + targetId);

    // Clear any outstanding timers
    clearTimeout(readyTimer);
    clearTimeout(disconnectTimer);
    clearTimeout(requestOfferTimer);
    clearTimeout(failTimer);

    // stop the monitor
//     mon.removeAllListeners();
    mon.close();

    // cleanup the peerconnection
    cleanup(pc);

    // remove listeners
    signaller.removeListener('sdp', handleSdp);
    signaller.removeListener('candidate', handleCandidate);
    signaller.removeListener('endofcandidates', handleLastCandidate);
    signaller.removeListener('negotiate', handleNegotiateRequest);
    signaller.removeListener('ready', handleReady);
    signaller.removeListener('requestoffer', handleRequestOffer);

    // remove listeners (version >= 5)
    signaller.removeListener('message:sdp', handleSdp);
    signaller.removeListener('message:candidate', handleCandidate);
    signaller.removeListener('message:endofcandidates', handleLastCandidate);
    signaller.removeListener('message:negotiate', handleNegotiateRequest);
    signaller.removeListener('message:ready', handleReady);
    signaller.removeListener('message:requestoffer', handleRequestOffer);

  }

  function handleCandidate(data, src) {
    // if the source is unknown or not a match, then don't process
    if ((! src) || (src.id !== targetId)) {
      return;
    }

    q.addIceCandidate(data);
  }

  // No op
  function handleLastCandidate() {
  }

  function handleSdp(sdp, src) {
    // if the source is unknown or not a match, then don't process
    if ((! src) || (src.id !== targetId)) {
      return;
    }

    emit('sdp.remote', sdp);

    // To speed up things on the renegotiation side of things, determine whether we have
    // finished the coupling (offer -> answer) cycle, and whether it is safe to start
    // renegotiating prior to the iceConnectionState "completed" state
    q.setRemoteDescription(sdp).then(function() {

      // If this is the peer that is coupling, and we have received the answer so we can
      // and assume that coupling (offer -> answer) process is complete, so we can clear the coupling flag
      if (coupling && sdp.type === 'answer') {
        debug('coupling complete, can now trigger any pending renegotiations');
        if (isMaster && negotiationRequired) createOrRequestOffer();
      }
    });
  }

  function handleReady(src) {
    if (targetReady || !src || src.id !== targetId) {
      return;
    }
    debug('[' + signaller.id + '] ' + targetId + ' is ready for coupling');
    targetReady = true;
    targetInfo = src.data;
    interoperating = (targetInfo.browser !== signaller.attributes.browser);
    emit('target.ready');
  }

  function handleConnectionClose() {
    debug('captured pc close, iceConnectionState = ' + pc.iceConnectionState);
    decouple();
  }

  function handleDisconnect() {
    debug('captured pc disconnect, monitoring connection status');

    // start the disconnect timer
    disconnectTimer = setTimeout(function() {
      debug('manually closing connection after disconnect timeout');
      mon('failed');
      cleanup(pc);
    }, disconnectTimeout);

    mon.on('statechange', handleDisconnectAbort);
    mon('failing');
  }

  function handleDisconnectAbort() {
    debug('connection state changed to: ' + pc.iceConnectionState);

    // if the state is checking, then do not reset the disconnect timer as
    // we are doing our own checking
    if (CHECKING_STATES.indexOf(pc.iceConnectionState) >= 0) {
      return;
    }

    resetDisconnectTimer();

    // if we have a closed or failed status, then close the connection
    if (CLOSED_STATES.indexOf(pc.iceConnectionState) >= 0) {
      return mon('closed');
    }

    mon.once('disconnect', handleDisconnect);
  }

  function handleLocalCandidate(evt) {
    var data = evt.candidate && pluckCandidate(evt.candidate);

    if (evt.candidate) {
      resetDisconnectTimer();
      emit('ice.local', data);
      signaller.to(targetId).send('/candidate', data);
      endOfCandidates = false;
    }
    else if (! endOfCandidates) {
      endOfCandidates = true;
      emit('ice.gathercomplete');
      signaller.to(targetId).send('/endofcandidates', {});
    }
  }

  function requestNegotiation() {
    // This is a redundant request if not reactive
    if (coupling && !reactive) return;

    // If no coupling is occurring, regardless of reactive, start the offer process
    if (!coupling) return createOrRequestOffer();

    // If we are already coupling, we are reactive and renegotiation has not been indicated
    // defer a negotiation request
    if (coupling && reactive && !negotiationRequired) {
      debug('renegotiation is required, but deferring until existing connection is established');
      negotiationRequired = true;

      // NOTE: This is commented out, as the functionality after the setRemoteDescription
      // should adequately take care of this. But should it not, re-enable this
      // mon.once('connectionstate:completed', function() {
      //   createOrRequestOffer();
      // });
    }
  }


  /**
    This allows the master to request the client to send an offer
   **/
  function requestOfferFromClient() {
    if (requestOfferTimer) clearTimeout(requestOfferTimer);
    if (pc.signalingState === 'closed') return;

    // Check if we are ready for a new offer, otherwise delay
    if (!isReadyForOffer()) {
      debug('[' + signaller.id + '] negotiation request denied, not in a state to accept new offers [coupling = ' + coupling + ', ' + pc.signalingState + ']');
      requestOfferTimer = setTimeout(requestOfferFromClient, 500);
    } else {
       // Flag as coupling and request the client send the offer
      debug('[' + signaller.id + '] ' + targetId + ' has requested the ability to create the offer');
      coupling = true;
      return signaller.to(targetId).send('/requestoffer');
    }
  }

  function handleNegotiateRequest(data, src) {
    debug('[' + signaller.id + '] ' + src.id + ' has requested a negotiation');

    // Sanity check that this is for the target
    if (!src || src.id !== targetId) return;
    emit('negotiate.request', src.id, data);

    // Check if the client is requesting the ability to create the offer themselves
    if (data && data.requestOfferer) {
      return requestOfferFromClient();
    }

    // Otherwise, begin the traditional master driven negotiation process
    requestNegotiation();
  }

  function handleRenegotiateRequest() {
    if (!reactive) return;
    emit('negotiate.renegotiate');
    renegotiateRequired = true;
    requestNegotiation();
  }

  function resetDisconnectTimer() {
    var recovered = !!disconnectTimer && CLOSED_STATES.indexOf(pc.iceConnectionState) === -1;
    mon.off('statechange', handleDisconnectAbort);

    // clear the disconnect timer
    debug('reset disconnect timer, state: ' + pc.iceConnectionState);
    clearTimeout(disconnectTimer);
    disconnectTimer = undefined;

    // Trigger the recovered event if this is a recovery
    if (recovered) {
      mon('recovered');
    }
  }

  /**
    Allow clients to send offers
   **/
  function handleRequestOffer(src) {
    if (!src || src.id !== targetId) return;
    debug('[' + signaller.id + '] ' + targetId + ' has requested that the offer be sent [' + src.id + ']');
    return createOffer();
  }

  // when regotiation is needed look for the peer
  if (reactive) {
    pc.onnegotiationneeded = handleRenegotiateRequest;
  }

  pc.onicecandidate = handleLocalCandidate;

  // when the task queue tells us we have sdp available, send that over the wire
  q.on('sdp.local', function(desc) {
    signaller.to(targetId).send('/sdp', desc);
  });

  // when we receive sdp, then
  signaller.on('sdp', handleSdp);
  signaller.on('candidate', handleCandidate);
  signaller.on('endofcandidates', handleLastCandidate);
  signaller.on('ready', handleReady);

  // listeners (signaller >= 5)
  signaller.on('message:sdp', handleSdp);
  signaller.on('message:candidate', handleCandidate);
  signaller.on('message:endofcandidates', handleLastCandidate);
  signaller.on('message:ready', handleReady);

  // if this is a master connection, listen for negotiate events
  if (isMaster) {
    signaller.on('negotiate', handleNegotiateRequest);
    signaller.on('message:negotiate', handleNegotiateRequest); // signaller >= 5
  } else {
    signaller.on('requestoffer', handleRequestOffer);
    signaller.on('message:requestoffer', handleRequestOffer);
  }

  // when the connection closes, remove event handlers
  mon.once('closed', handleConnectionClose);
  mon.once('disconnected', handleDisconnect);

  // patch in the create offer functions
  mon.createOffer = createOrRequestOffer;

  // A heavy handed approach to ensuring readiness across the coupling
  // peers. Will periodically send the `ready` message to the target peer
  // until the target peer has acknowledged that it also is ready - at which
  // point the offer can be sent
  function checkReady() {
    clearTimeout(readyTimer);
    signaller.to(targetId).send('/ready');

    // If we are ready, they've told us they are ready, and we've told
    // them we're ready, then exit
    if (targetReady) return;

    // Otherwise, keep telling them we're ready
    readyTimer = setTimeout(checkReady, readyInterval);
  }
  checkReady();
  debug('[' + signaller.id + '] ready for coupling to ' + targetId);

  // If we fail to connect within the given timeframe, trigger a failure
  failTimer = setTimeout(function() {
    mon('failed');
    decouple();
  }, failTimeout);

  mon.once('connected', function() {
    clearTimeout(failTimer);
  });

  mon.on('signalingchange', function(pc, state) {
    debug('[' + signaller.id + '] signaling state ' + state + ' to ' + targetId);
  });

  mon.on('signaling:stable', function() {
    // Check if the coupling process is over
    // creatingOffer is required due to the delay between the creation of the offer and the signaling
    // state changing to have-local-offer
    if (!creatingOffer && coupling) coupling = false;

    // Check if we have any pending negotiations
    if (negotiationRequired) {
      createOrRequestOffer();
    }
  });

  mon.stop = decouple;

  /**
    Aborts the coupling process
   **/
  mon.abort = function() {
    if (failTimer) {
      clearTimeout(failTimer);
    }
    decouple();
    mon('aborted');
  };

  // Override destroy to clear the task queue as well
  mon.destroy = function() {
    mon.clear();
    q.clear();
  };

  return mon;
}

module.exports = couple;
},{"./cleanup":25,"./monitor":30,"cog/logger":9,"cog/throttle":10,"mbus":14,"rtc-taskqueue":24,"whisk/pluck":36}],27:[function(require,module,exports){
/* jshint node: true */
'use strict';

/**
  ### rtc-tools/detect

  Provide the [rtc-core/detect](https://github.com/rtc-io/rtc-core#detect)
  functionality.
**/
module.exports = require('rtc-core/detect');

},{"rtc-core/detect":18}],28:[function(require,module,exports){
/* jshint node: true */
'use strict';

var debug = require('cog/logger')('generators');
var detect = require('./detect');
var defaults = require('cog/defaults');

var mappings = {
  create: {
    dtls: function(c) {
      if (! detect.moz) {
        c.optional = (c.optional || []).concat({ DtlsSrtpKeyAgreement: true });
      }
    }
  }
};

/**
  ### rtc-tools/generators

  The generators package provides some utility methods for generating
  constraint objects and similar constructs.

  ```js
  var generators = require('rtc/generators');
  ```

**/

/**
  #### generators.config(config)

  Generate a configuration object suitable for passing into an W3C
  RTCPeerConnection constructor first argument, based on our custom config.

  In the event that you use short term authentication for TURN, and you want
  to generate new `iceServers` regularly, you can specify an iceServerGenerator
  that will be used prior to coupling. This generator should return a fully
  compliant W3C (RTCIceServer dictionary)[http://www.w3.org/TR/webrtc/#idl-def-RTCIceServer].

  If you pass in both a generator and iceServers, the iceServers _will be
  ignored and the generator used instead.
**/

exports.config = function(config) {
  var iceServerGenerator = (config || {}).iceServerGenerator;

  return defaults({}, config, {
    iceServers: typeof iceServerGenerator == 'function' ? iceServerGenerator() : []
  });
};

/**
  #### generators.connectionConstraints(flags, constraints)

  This is a helper function that will generate appropriate connection
  constraints for a new `RTCPeerConnection` object which is constructed
  in the following way:

  ```js
  var conn = new RTCPeerConnection(flags, constraints);
  ```

  In most cases the constraints object can be left empty, but when creating
  data channels some additional options are required.  This function
  can generate those additional options and intelligently combine any
  user defined constraints (in `constraints`) with shorthand flags that
  might be passed while using the `rtc.createConnection` helper.
**/
exports.connectionConstraints = function(flags, constraints) {
  var generated = {};
  var m = mappings.create;
  var out;

  // iterate through the flags and apply the create mappings
  Object.keys(flags || {}).forEach(function(key) {
    if (m[key]) {
      m[key](generated);
    }
  });

  // generate the connection constraints
  out = defaults({}, constraints, generated);
  debug('generated connection constraints: ', out);

  return out;
};

},{"./detect":27,"cog/defaults":6,"cog/logger":9}],29:[function(require,module,exports){
/* jshint node: true */

'use strict';

/**
  # rtc-tools

  The `rtc-tools` module does most of the heavy lifting within the
  [rtc.io](http://rtc.io) suite.  Primarily it handles the logic of coupling
  a local `RTCPeerConnection` with it's remote counterpart via an
  [rtc-signaller](https://github.com/rtc-io/rtc-signaller) signalling
  channel.

  ## Getting Started

  If you decide that the `rtc-tools` module is a better fit for you than either
  [rtc-quickconnect](https://github.com/rtc-io/rtc-quickconnect) or
  [rtc](https://github.com/rtc-io/rtc) then the code snippet below
  will provide you a guide on how to get started using it in conjunction with
  the [rtc-signaller](https://github.com/rtc-io/rtc-signaller) (version 5.0 and above)
  and [rtc-media](https://github.com/rtc-io/rtc-media) modules:

  <<< examples/getting-started.js

  This code definitely doesn't cover all the cases that you need to consider
  (i.e. peers leaving, etc) but it should demonstrate how to:

  1. Capture video and add it to a peer connection
  2. Couple a local peer connection with a remote peer connection
  3. Deal with the remote steam being discovered and how to render
     that to the local interface.

  ## Reference

**/

var gen = require('./generators');

// export detect
var detect = exports.detect = require('./detect');
var findPlugin = require('rtc-core/plugin');

// export cog logger for convenience
exports.logger = require('cog/logger');

// export peer connection
var RTCPeerConnection =
exports.RTCPeerConnection = detect('RTCPeerConnection');

// add the couple utility
exports.couple = require('./couple');

/**
  ### createConnection

  ```
  createConnection(opts?, constraints?) => RTCPeerConnection
  ```

  Create a new `RTCPeerConnection` auto generating default opts as required.

  ```js
  var conn;

  // this is ok
  conn = rtc.createConnection();

  // and so is this
  conn = rtc.createConnection({
    iceServers: []
  });
  ```
**/
exports.createConnection = function(opts, constraints) {
  var plugin = findPlugin((opts || {}).plugins);
  var PeerConnection = (opts || {}).RTCPeerConnection || RTCPeerConnection;

  // generate the config based on options provided
  var config = gen.config(opts);

  // generate appropriate connection constraints
  constraints = gen.connectionConstraints(opts, constraints);

  if (plugin && typeof plugin.createConnection == 'function') {
    return plugin.createConnection(config, constraints);
  }

  return new PeerConnection(config, constraints);
};

},{"./couple":26,"./detect":27,"./generators":28,"cog/logger":9,"rtc-core/plugin":20}],30:[function(require,module,exports){
/* jshint node: true */
'use strict';

var mbus = require('mbus');

// define some state mappings to simplify the events we generate
var stateMappings = {
  completed: 'connected'
};

// define the events that we need to watch for peer connection
// state changes
var peerStateEvents = [
  'signalingstatechange',
  'iceconnectionstatechange',
];

/**
  ### rtc-tools/monitor

  ```
  monitor(pc, targetId, signaller, parentBus) => mbus
  ```

  The monitor is a useful tool for determining the state of `pc` (an
  `RTCPeerConnection`) instance in the context of your application. The
  monitor uses both the `iceConnectionState` information of the peer
  connection and also the various
  [signaller events](https://github.com/rtc-io/rtc-signaller#signaller-events)
  to determine when the connection has been `connected` and when it has
  been `disconnected`.

  A monitor created `mbus` is returned as the result of a
  [couple](https://github.com/rtc-io/rtc#rtccouple) between a local peer
  connection and it's remote counterpart.

**/
module.exports = function(pc, targetId, signaller, parentBus) {
  var monitor = mbus('', parentBus);
  var state;
  var connectionState;
  var signalingState;
  var isClosed = false;

  function checkState() {
    var newConnectionState = pc.iceConnectionState;
    var newState = getMappedState(newConnectionState);
    var newSignalingState = pc.signalingState;

    // flag the we had a state change
    monitor('statechange', pc, newState);
    monitor('connectionstatechange', pc, newConnectionState);

    // if the active state has changed, then send the appopriate message
    if (state !== newState) {
      monitor(newState);
      state = newState;
    }

    if (connectionState !== newConnectionState) {
      monitor('connectionstate:' + newConnectionState);
      connectionState = newConnectionState;
    }

    // As Firefox does not always support `onclose`, if the state is closed
    // and we haven't already handled the close, do so now
    if (newState === 'closed' && !isClosed) {
      handleClose();
    }

    // Check the signalling state to see if it has also changed
    if (signalingState !== newSignalingState) {
      monitor('signalingchange', pc, newSignalingState, signalingState);
      monitor('signaling:' + newSignalingState, pc, newSignalingState, signalingState);
      signalingState = newSignalingState;
    }
  }

  function handleClose() {
    isClosed = true;
    monitor('closed');
  }

  pc.onclose = handleClose;
  peerStateEvents.forEach(function(evtName) {
    pc['on' + evtName] = checkState;
  });

  monitor.close = function() {
    pc.onclose = null;
    peerStateEvents.forEach(function(evtName) {
      pc['on' + evtName] = null;
    });
  };

  monitor.checkState = checkState;

  monitor.destroy = function() {
    monitor.clear();
  };

  // if we haven't been provided a valid peer connection, abort
  if (! pc) {
    return monitor;
  }

  // determine the initial is active state
  state = getMappedState(pc.iceConnectionState);

  return monitor;
};

/* internal helpers */

function getMappedState(state) {
  return stateMappings[state] || state;
}

},{"mbus":14}],31:[function(require,module,exports){
var debug = require('cog/logger')('rtc-validator');
var rePrefix = /^(?:a=)?candidate:/;

/*

validation rules as per:
http://tools.ietf.org/html/draft-ietf-mmusic-ice-sip-sdp-03#section-8.1

   candidate-attribute   = "candidate" ":" foundation SP component-id SP
                           transport SP
                           priority SP
                           connection-address SP     ;from RFC 4566
                           port         ;port from RFC 4566
                           SP cand-type
                           [SP rel-addr]
                           [SP rel-port]
                           *(SP extension-att-name SP
                                extension-att-value)

   foundation            = 1*32ice-char
   component-id          = 1*5DIGIT
   transport             = "UDP" / transport-extension
   transport-extension   = token              ; from RFC 3261
   priority              = 1*10DIGIT
   cand-type             = "typ" SP candidate-types
   candidate-types       = "host" / "srflx" / "prflx" / "relay" / token
   rel-addr              = "raddr" SP connection-address
   rel-port              = "rport" SP port
   extension-att-name    = token
   extension-att-value   = *VCHAR
   ice-char              = ALPHA / DIGIT / "+" / "/"
*/
var partValidation = [
  [ /.+/, 'invalid foundation component', 'foundation' ],
  [ /\d+/, 'invalid component id', 'component-id' ],
  [ /(UDP|TCP)/i, 'transport must be TCP or UDP', 'transport' ],
  [ /\d+/, 'numeric priority expected', 'priority' ],
  [ require('reu/ip'), 'invalid connection address', 'connection-address' ],
  [ /\d+/, 'invalid connection port', 'connection-port' ],
  [ /typ/, 'Expected "typ" identifier', 'type classifier' ],
  [ /.+/, 'Invalid candidate type specified', 'candidate-type' ]
];

/**
  ### `rtc-validator/candidate`

  Validate that an `RTCIceCandidate` (or plain old object with data, sdpMid,
  etc attributes) is a valid ice candidate.

  Specs reviewed as part of the validation implementation:

  - <http://tools.ietf.org/html/draft-ietf-mmusic-ice-sip-sdp-03#section-8.1>
  - <http://tools.ietf.org/html/rfc5245>

**/
module.exports = function(data) {
  var errors = [];
  var candidate = data && (data.candidate || data);
  var prefixMatch = candidate && rePrefix.exec(candidate);
  var parts = prefixMatch && candidate.slice(prefixMatch[0].length).split(/\s/);

  if (! candidate) {
    return [ new Error('empty candidate') ];
  }

  // check that the prefix matches expected
  if (! prefixMatch) {
    return [ new Error('candidate did not match expected sdp line format') ];
  }

  // perform the part validation
  errors = errors.concat(parts.map(validateParts)).filter(Boolean);

  return errors;
};

function validateParts(part, idx) {
  var validator = partValidation[idx];

  if (validator && (! validator[0].test(part))) {
    debug(validator[2] + ' part failed validation: ' + part);
    return new Error(validator[1]);
  }
}

},{"cog/logger":9,"reu/ip":17}],32:[function(require,module,exports){
module.exports = function(a, b) {
  return arguments.length > 1 ? a === b : function(b) {
    return a === b;
  };
};

},{}],33:[function(require,module,exports){
/**
  ## flatten

  Flatten an array using `[].reduce`

  <<< examples/flatten.js

**/

module.exports = function(a, b) {
  // if a is not already an array, make it one
  a = Array.isArray(a) ? a : [a];

  // concat b with a
  return a.concat(b);
};
},{}],34:[function(require,module,exports){
module.exports = function(comparator) {
  return function(input) {
    var output = [];
    for (var ii = 0, count = input.length; ii < count; ii++) {
      var found = false;
      for (var jj = output.length; jj--; ) {
        found = found || comparator(input[ii], output[jj]);
      }

      if (found) {
        continue;
      }

      output[output.length] = input[ii];
    }

    return output;
  };
}
},{}],35:[function(require,module,exports){
/**
  ## nub

  Return only the unique elements of the list.

  <<< examples/nub.js

**/

module.exports = require('./nub-by')(require('./equality'));
},{"./equality":32,"./nub-by":34}],36:[function(require,module,exports){
/**
  ## pluck

  Extract targeted properties from a source object. When a single property
  value is requested, then just that value is returned.

  In the case where multiple properties are requested (in a varargs calling
  style) a new object will be created with the requested properties copied
  across.

  __NOTE:__ In the second form extraction of nested properties is
  not supported.

  <<< examples/pluck.js

**/
module.exports = function() {
  var fields = [];

  function extractor(parts, maxIdx) {
    return function(item) {
      var partIdx = 0;
      var val = item;

      do {
        val = val && val[parts[partIdx++]];
      } while (val && partIdx <= maxIdx);

      return val;
    };
  }

  [].slice.call(arguments).forEach(function(path) {
    var parts = typeof path == 'number' ? [ path ] : (path || '').split('.');

    fields[fields.length] = {
      name: parts[0],
      parts: parts,
      maxIdx: parts.length - 1
    };
  });

  if (fields.length <= 1) {
    return extractor(fields[0].parts, fields[0].maxIdx);
  }
  else {
    return function(item) {
      var data = {};

      for (var ii = 0, len = fields.length; ii < len; ii++) {
        data[fields[ii].name] = extractor([fields[ii].parts[0]], 0)(item);
      }

      return data;
    };
  }
};
},{}]},{},[1])(1)
});
//# sourceMappingURL=data:application/json;charset:utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9ncnVudC1icm93c2VyaWZ5L25vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCJpbmRleC5qcyIsImxpYi9jYWxscy5qcyIsImxpYi9nZXRwZWVyZGF0YS5qcyIsImxpYi9oZWFydGJlYXQuanMiLCJsaWIvc2NoZW1lcy5qcyIsIm5vZGVfbW9kdWxlcy9jb2cvZGVmYXVsdHMuanMiLCJub2RlX21vZHVsZXMvY29nL2V4dGVuZC5qcyIsIm5vZGVfbW9kdWxlcy9jb2cvZ2V0YWJsZS5qcyIsIm5vZGVfbW9kdWxlcy9jb2cvbG9nZ2VyLmpzIiwibm9kZV9tb2R1bGVzL2NvZy90aHJvdHRsZS5qcyIsIm5vZGVfbW9kdWxlcy9kZXRlY3QtYnJvd3Nlci9icm93c2VyLmpzIiwibm9kZV9tb2R1bGVzL2RldGVjdC1icm93c2VyL2xpYi9kZXRlY3RCcm93c2VyLmpzIiwibm9kZV9tb2R1bGVzL2VzNi1wcm9taXNlL2Rpc3QvZXM2LXByb21pc2UuanMiLCJub2RlX21vZHVsZXMvbWJ1cy9pbmRleC5qcyIsIm5vZGVfbW9kdWxlcy9wcmlvcml0eXF1ZXVlanMvaW5kZXguanMiLCJub2RlX21vZHVsZXMvcHJvY2Vzcy9icm93c2VyLmpzIiwibm9kZV9tb2R1bGVzL3JldS9pcC5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtY29yZS9kZXRlY3QuanMiLCJub2RlX21vZHVsZXMvcnRjLWNvcmUvZ2VuaWNlLmpzIiwibm9kZV9tb2R1bGVzL3J0Yy1jb3JlL3BsdWdpbi5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtc2RwL2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL3J0Yy1zZHAvcGFyc2Vycy5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtc2RwY2xlYW4vaW5kZXguanMiLCJub2RlX21vZHVsZXMvcnRjLXRhc2txdWV1ZS9pbmRleC5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtdG9vbHMvY2xlYW51cC5qcyIsIm5vZGVfbW9kdWxlcy9ydGMtdG9vbHMvY291cGxlLmpzIiwibm9kZV9tb2R1bGVzL3J0Yy10b29scy9kZXRlY3QuanMiLCJub2RlX21vZHVsZXMvcnRjLXRvb2xzL2dlbmVyYXRvcnMuanMiLCJub2RlX21vZHVsZXMvcnRjLXRvb2xzL2luZGV4LmpzIiwibm9kZV9tb2R1bGVzL3J0Yy10b29scy9tb25pdG9yLmpzIiwibm9kZV9tb2R1bGVzL3J0Yy12YWxpZGF0b3IvY2FuZGlkYXRlLmpzIiwibm9kZV9tb2R1bGVzL3doaXNrL2VxdWFsaXR5LmpzIiwibm9kZV9tb2R1bGVzL3doaXNrL2ZsYXR0ZW4uanMiLCJub2RlX21vZHVsZXMvd2hpc2svbnViLWJ5LmpzIiwibm9kZV9tb2R1bGVzL3doaXNrL251Yi5qcyIsIm5vZGVfbW9kdWxlcy93aGlzay9wbHVjay5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7QUNBQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7OztBQ2g2QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDaE9BO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ05BO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM1RkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3JEQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3hDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNqQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMzQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNySUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbkRBO0FBQ0E7QUFDQTtBQUNBOztBQ0hBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7O0FDL0NBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7QUNqb0NBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM3S0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM1S0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDcExBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1RBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzNFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM5QkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3BCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN6SkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZEQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbmRBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNwRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNsZEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNWQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2RkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3pGQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNySEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDcEZBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNMQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNmQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNsQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDVEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBIiwiZmlsZSI6ImdlbmVyYXRlZC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzQ29udGVudCI6WyIoZnVuY3Rpb24gZSh0LG4scil7ZnVuY3Rpb24gcyhvLHUpe2lmKCFuW29dKXtpZighdFtvXSl7dmFyIGE9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtpZighdSYmYSlyZXR1cm4gYShvLCEwKTtpZihpKXJldHVybiBpKG8sITApO3ZhciBmPW5ldyBFcnJvcihcIkNhbm5vdCBmaW5kIG1vZHVsZSAnXCIrbytcIidcIik7dGhyb3cgZi5jb2RlPVwiTU9EVUxFX05PVF9GT1VORFwiLGZ9dmFyIGw9bltvXT17ZXhwb3J0czp7fX07dFtvXVswXS5jYWxsKGwuZXhwb3J0cyxmdW5jdGlvbihlKXt2YXIgbj10W29dWzFdW2VdO3JldHVybiBzKG4/bjplKX0sbCxsLmV4cG9ydHMsZSx0LG4scil9cmV0dXJuIG5bb10uZXhwb3J0c312YXIgaT10eXBlb2YgcmVxdWlyZT09XCJmdW5jdGlvblwiJiZyZXF1aXJlO2Zvcih2YXIgbz0wO288ci5sZW5ndGg7bysrKXMocltvXSk7cmV0dXJuIHN9KSIsIi8qIGpzaGludCBub2RlOiB0cnVlICovXG4vKiBnbG9iYWwgbG9jYXRpb24gKi9cbid1c2Ugc3RyaWN0JztcblxudmFyIHJ0YyA9IHJlcXVpcmUoJ3J0Yy10b29scycpO1xudmFyIG1idXMgPSByZXF1aXJlKCdtYnVzJyk7XG52YXIgZGV0ZWN0UGx1Z2luID0gcmVxdWlyZSgncnRjLWNvcmUvcGx1Z2luJyk7XG52YXIgZGVidWcgPSBydGMubG9nZ2VyKCdydGMtcXVpY2tjb25uZWN0Jyk7XG52YXIgZXh0ZW5kID0gcmVxdWlyZSgnY29nL2V4dGVuZCcpO1xuXG4vKipcbiAgIyBydGMtcXVpY2tjb25uZWN0XG5cbiAgVGhpcyBpcyBhIGhpZ2ggbGV2ZWwgaGVscGVyIG1vZHVsZSBkZXNpZ25lZCB0byBoZWxwIHlvdSBnZXQgdXBcbiAgYW4gcnVubmluZyB3aXRoIFdlYlJUQyByZWFsbHksIHJlYWxseSBxdWlja2x5LiAgQnkgdXNpbmcgdGhpcyBtb2R1bGUgeW91XG4gIGFyZSB0cmFkaW5nIG9mZiBzb21lIGZsZXhpYmlsaXR5LCBzbyBpZiB5b3UgbmVlZCBhIG1vcmUgZmxleGlibGVcbiAgY29uZmlndXJhdGlvbiB5b3Ugc2hvdWxkIGRyaWxsIGRvd24gaW50byBsb3dlciBsZXZlbCBjb21wb25lbnRzIG9mIHRoZVxuICBbcnRjLmlvXShodHRwOi8vd3d3LnJ0Yy5pbykgc3VpdGUuICBJbiBwYXJ0aWN1bGFyIHlvdSBzaG91bGQgY2hlY2sgb3V0XG4gIFtydGNdKGh0dHBzOi8vZ2l0aHViLmNvbS9ydGMtaW8vcnRjKS5cblxuICAjIyBFeGFtcGxlIFVzYWdlXG5cbiAgSW4gdGhlIHNpbXBsZXN0IGNhc2UgeW91IHNpbXBseSBjYWxsIHF1aWNrY29ubmVjdCB3aXRoIGEgc2luZ2xlIHN0cmluZ1xuICBhcmd1bWVudCB3aGljaCB0ZWxscyBxdWlja2Nvbm5lY3Qgd2hpY2ggc2VydmVyIHRvIHVzZSBmb3Igc2lnbmFsaW5nOlxuXG4gIDw8PCBleGFtcGxlcy9zaW1wbGUuanNcblxuICA8PDwgZG9jcy9ldmVudHMubWRcblxuICA8PDwgZG9jcy9leGFtcGxlcy5tZFxuXG4gICMjIFJlZ2FyZGluZyBTaWduYWxsaW5nIGFuZCBhIFNpZ25hbGxpbmcgU2VydmVyXG5cbiAgU2lnbmFsaW5nIGlzIGFuIGltcG9ydGFudCBwYXJ0IG9mIHNldHRpbmcgdXAgYSBXZWJSVEMgY29ubmVjdGlvbiBhbmQgZm9yXG4gIG91ciBleGFtcGxlcyB3ZSB1c2Ugb3VyIG93biB0ZXN0IGluc3RhbmNlIG9mIHRoZVxuICBbcnRjLXN3aXRjaGJvYXJkXShodHRwczovL2dpdGh1Yi5jb20vcnRjLWlvL3J0Yy1zd2l0Y2hib2FyZCkuIEZvciB5b3VyXG4gIHRlc3RpbmcgYW5kIGRldmVsb3BtZW50IHlvdSBhcmUgbW9yZSB0aGFuIHdlbGNvbWUgdG8gdXNlIHRoaXMgYWxzbywgYnV0XG4gIGp1c3QgYmUgYXdhcmUgdGhhdCB3ZSB1c2UgdGhpcyBmb3Igb3VyIHRlc3Rpbmcgc28gaXQgbWF5IGdvIHVwIGFuZCBkb3duXG4gIGEgbGl0dGxlLiAgSWYgeW91IG5lZWQgc29tZXRoaW5nIG1vcmUgc3RhYmxlLCB3aHkgbm90IGNvbnNpZGVyIGRlcGxveWluZ1xuICBhbiBpbnN0YW5jZSBvZiB0aGUgc3dpdGNoYm9hcmQgeW91cnNlbGYgLSBpdCdzIHByZXR0eSBlYXN5IDopXG5cbiAgIyMgUmVmZXJlbmNlXG5cbiAgYGBgXG4gIHF1aWNrY29ubmVjdChzaWduYWxob3N0LCBvcHRzPykgPT4gcnRjLXNpZ2FsbGVyIGluc3RhbmNlICgrIGhlbHBlcnMpXG4gIGBgYFxuXG4gICMjIyBWYWxpZCBRdWljayBDb25uZWN0IE9wdGlvbnNcblxuICBUaGUgb3B0aW9ucyBwcm92aWRlZCB0byB0aGUgYHJ0Yy1xdWlja2Nvbm5lY3RgIG1vZHVsZSBmdW5jdGlvbiBpbmZsdWVuY2UgdGhlXG4gIGJlaGF2aW91ciBvZiBzb21lIG9mIHRoZSB1bmRlcmx5aW5nIGNvbXBvbmVudHMgdXNlZCBmcm9tIHRoZSBydGMuaW8gc3VpdGUuXG5cbiAgTGlzdGVkIGJlbG93IGFyZSBzb21lIG9mIHRoZSBjb21tb25seSB1c2VkIG9wdGlvbnM6XG5cbiAgLSBgbnNgIChkZWZhdWx0OiAnJylcblxuICAgIEFuIG9wdGlvbmFsIG5hbWVzcGFjZSBmb3IgeW91ciBzaWduYWxsaW5nIHJvb20uICBXaGlsZSBxdWlja2Nvbm5lY3RcbiAgICB3aWxsIGdlbmVyYXRlIGEgdW5pcXVlIGhhc2ggZm9yIHRoZSByb29tLCB0aGlzIGNhbiBiZSBtYWRlIHRvIGJlIG1vcmVcbiAgICB1bmlxdWUgYnkgcHJvdmlkaW5nIGEgbmFtZXNwYWNlLiAgVXNpbmcgYSBuYW1lc3BhY2UgbWVhbnMgdHdvIGRlbW9zXG4gICAgdGhhdCBoYXZlIGdlbmVyYXRlZCB0aGUgc2FtZSBoYXNoIGJ1dCB1c2UgYSBkaWZmZXJlbnQgbmFtZXNwYWNlIHdpbGwgYmVcbiAgICBpbiBkaWZmZXJlbnQgcm9vbXMuXG5cbiAgLSBgcm9vbWAgKGRlZmF1bHQ6IG51bGwpIF9hZGRlZCAwLjZfXG5cbiAgICBSYXRoZXIgdGhhbiB1c2UgdGhlIGludGVybmFsIGhhc2ggZ2VuZXJhdGlvblxuICAgIChwbHVzIG9wdGlvbmFsIG5hbWVzcGFjZSkgZm9yIHJvb20gbmFtZSBnZW5lcmF0aW9uLCBzaW1wbHkgdXNlIHRoaXMgcm9vbVxuICAgIG5hbWUgaW5zdGVhZC4gIF9fTk9URTpfXyBVc2Ugb2YgdGhlIGByb29tYCBvcHRpb24gdGFrZXMgcHJlY2VuZGVuY2Ugb3ZlclxuICAgIGBuc2AuXG5cbiAgLSBgZGVidWdgIChkZWZhdWx0OiBmYWxzZSlcblxuICBXcml0ZSBydGMuaW8gc3VpdGUgZGVidWcgb3V0cHV0IHRvIHRoZSBicm93c2VyIGNvbnNvbGUuXG5cbiAgLSBgZXhwZWN0ZWRMb2NhbFN0cmVhbXNgIChkZWZhdWx0OiBub3Qgc3BlY2lmaWVkKSBfYWRkZWQgMy4wX1xuXG4gICAgQnkgcHJvdmlkaW5nIGEgcG9zaXRpdmUgaW50ZWdlciB2YWx1ZSBmb3IgdGhpcyBvcHRpb24gd2lsbCBtZWFuIHRoYXRcbiAgICB0aGUgY3JlYXRlZCBxdWlja2Nvbm5lY3QgaW5zdGFuY2Ugd2lsbCB3YWl0IHVudGlsIHRoZSBzcGVjaWZpZWQgbnVtYmVyIG9mXG4gICAgc3RyZWFtcyBoYXZlIGJlZW4gYWRkZWQgdG8gdGhlIHF1aWNrY29ubmVjdCBcInRlbXBsYXRlXCIgYmVmb3JlIGFubm91bmNpbmdcbiAgICB0byB0aGUgc2lnbmFsaW5nIHNlcnZlci5cblxuICAtIGBtYW51YWxKb2luYCAoZGVmYXVsdDogYGZhbHNlYClcblxuICAgIFNldCB0aGlzIHZhbHVlIHRvIGB0cnVlYCBpZiB5b3Ugd291bGQgcHJlZmVyIHRvIGNhbGwgdGhlIGBqb2luYCBmdW5jdGlvblxuICAgIHRvIGNvbm5lY3RpbmcgdG8gdGhlIHNpZ25hbGxpbmcgc2VydmVyLCByYXRoZXIgdGhhbiBoYXZpbmcgdGhhdCBoYXBwZW5cbiAgICBhdXRvbWF0aWNhbGx5IGFzIHNvb24gYXMgcXVpY2tjb25uZWN0IGlzIHJlYWR5IHRvLlxuXG4gICMjIyMgT3B0aW9ucyBmb3IgUGVlciBDb25uZWN0aW9uIENyZWF0aW9uXG5cbiAgT3B0aW9ucyB0aGF0IGFyZSBwYXNzZWQgb250byB0aGVcbiAgW3J0Yy5jcmVhdGVDb25uZWN0aW9uXShodHRwczovL2dpdGh1Yi5jb20vcnRjLWlvL3J0YyNjcmVhdGVjb25uZWN0aW9ub3B0cy1jb25zdHJhaW50cylcbiAgZnVuY3Rpb246XG5cbiAgLSBgaWNlU2VydmVyc2BcblxuICBUaGlzIHByb3ZpZGVzIGEgbGlzdCBvZiBpY2Ugc2VydmVycyB0aGF0IGNhbiBiZSB1c2VkIHRvIGhlbHAgbmVnb3RpYXRlIGFcbiAgY29ubmVjdGlvbiBiZXR3ZWVuIHBlZXJzLlxuXG4gICMjIyMgT3B0aW9ucyBmb3IgUDJQIG5lZ290aWF0aW9uXG5cbiAgVW5kZXIgdGhlIGhvb2QsIHF1aWNrY29ubmVjdCB1c2VzIHRoZVxuICBbcnRjL2NvdXBsZV0oaHR0cHM6Ly9naXRodWIuY29tL3J0Yy1pby9ydGMjcnRjY291cGxlKSBsb2dpYywgYW5kIHRoZSBvcHRpb25zXG4gIHBhc3NlZCB0byBxdWlja2Nvbm5lY3QgYXJlIGFsc28gcGFzc2VkIG9udG8gdGhpcyBmdW5jdGlvbi5cblxuKiovXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKHNpZ25hbGxlciwgb3B0cykge1xuICB2YXIgaGFzaCA9IHR5cGVvZiBsb2NhdGlvbiAhPSAndW5kZWZpbmVkJyAmJiBsb2NhdGlvbi5oYXNoLnNsaWNlKDEpO1xuXG4gIHZhciBnZXRQZWVyRGF0YSA9IHJlcXVpcmUoJy4vbGliL2dldHBlZXJkYXRhJykoc2lnbmFsbGVyLnBlZXJzKTtcbiAgdmFyIGdlbmVyYXRlSWNlU2VydmVycyA9IHJlcXVpcmUoJ3J0Yy1jb3JlL2dlbmljZScpO1xuXG4gIC8vIGluaXQgY29uZmlndXJhYmxlIHZhcnNcbiAgdmFyIG5zID0gKG9wdHMgfHwge30pLm5zIHx8ICcnO1xuICB2YXIgcm9vbSA9IChvcHRzIHx8IHt9KS5yb29tO1xuICB2YXIgZGVidWdnaW5nID0gKG9wdHMgfHwge30pLmRlYnVnO1xuICB2YXIgYWxsb3dKb2luID0gIShvcHRzIHx8IHt9KS5tYW51YWxKb2luO1xuICB2YXIgcHJvZmlsZSA9IHt9O1xuICB2YXIgYW5ub3VuY2VkID0gZmFsc2U7XG5cbiAgLy8gU2NoZW1lcyBhbGxvdyBjdXN0b21pc2F0aW9uIGFib3V0IGhvdyBjb25uZWN0aW9ucyBhcmUgbWFkZVxuICAvLyBJbiBwYXJ0aWN1bGFyLCBwcm92aWRpbmcgc2NoZW1lcyBhbGxvd3MgcHJvdmlkaW5nIGRpZmZlcmVudCBzZXRzIG9mIElDRSBzZXJ2ZXJzXG4gIC8vIGJldHdlZW4gcGVlcnNcbiAgdmFyIHNjaGVtZXMgPSByZXF1aXJlKCcuL2xpYi9zY2hlbWVzJykoc2lnbmFsbGVyLCBvcHRzKTtcblxuICAvLyBjb2xsZWN0IHRoZSBsb2NhbCBzdHJlYW1zXG4gIHZhciBsb2NhbFN0cmVhbXMgPSBbXTtcblxuICAvLyBjcmVhdGUgdGhlIGNhbGxzIG1hcFxuICB2YXIgY2FsbHMgPSBzaWduYWxsZXIuY2FsbHMgPSByZXF1aXJlKCcuL2xpYi9jYWxscycpKHNpZ25hbGxlciwgb3B0cyk7XG5cbiAgLy8gY3JlYXRlIHRoZSBrbm93biBkYXRhIGNoYW5uZWxzIHJlZ2lzdHJ5XG4gIHZhciBjaGFubmVscyA9IHt9O1xuICB2YXIgcGVuZGluZyA9IHt9O1xuICAvLyBSZWNvbm5lY3RpbmcgaW5kaWNhdGVzIHBlZXJzIHRoYXQgYXJlIGluIHRoZSBwcm9jZXNzIG9mIHJlY29ubmVjdGluZ1xuICB2YXIgcmVjb25uZWN0aW5nID0ge307XG5cbiAgLy8gc2F2ZSB0aGUgcGx1Z2lucyBwYXNzZWQgdG8gdGhlIHNpZ25hbGxlclxuICB2YXIgcGx1Z2lucyA9IHNpZ25hbGxlci5wbHVnaW5zID0gKG9wdHMgfHwge30pLnBsdWdpbnMgfHwgW107XG4gIHZhciBwbHVnaW4gPSBkZXRlY3RQbHVnaW4ocGx1Z2lucyk7XG4gIHZhciBwbHVnaW5SZWFkeTtcblxuICAvLyBjaGVjayBob3cgbWFueSBsb2NhbCBzdHJlYW1zIGhhdmUgYmVlbiBleHBlY3RlZCAoZGVmYXVsdDogMClcbiAgdmFyIGV4cGVjdGVkTG9jYWxTdHJlYW1zID0gcGFyc2VJbnQoKG9wdHMgfHwge30pLmV4cGVjdGVkTG9jYWxTdHJlYW1zLCAxMCkgfHwgMDtcbiAgdmFyIGFubm91bmNlVGltZXIgPSAwO1xuICB2YXIgdXBkYXRlVGltZXIgPSAwO1xuXG4gIGZ1bmN0aW9uIGNoZWNrUmVhZHlUb0Fubm91bmNlKCkge1xuICAgIGNsZWFyVGltZW91dChhbm5vdW5jZVRpbWVyKTtcbiAgICAvLyBpZiB3ZSBoYXZlIGFscmVhZHkgYW5ub3VuY2VkIGRvIG5vdGhpbmchXG4gICAgaWYgKGFubm91bmNlZCkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmICghIGFsbG93Sm9pbikge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIGlmIHdlIGhhdmUgYSBwbHVnaW4gYnV0IGl0J3Mgbm90IGluaXRpYWxpemVkIHdlIGFyZW4ndCByZWFkeVxuICAgIGlmIChwbHVnaW4gJiYgKCEgcGx1Z2luUmVhZHkpKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gaWYgd2UgYXJlIHdhaXRpbmcgZm9yIGEgc2V0IG51bWJlciBvZiBzdHJlYW1zLCB0aGVuIHdhaXQgdW50aWwgd2UgaGF2ZVxuICAgIC8vIHRoZSByZXF1aXJlZCBudW1iZXJcbiAgICBpZiAoZXhwZWN0ZWRMb2NhbFN0cmVhbXMgJiYgbG9jYWxTdHJlYW1zLmxlbmd0aCA8IGV4cGVjdGVkTG9jYWxTdHJlYW1zKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gYW5ub3VuY2Ugb3Vyc2VsdmVzIHRvIG91ciBuZXcgZnJpZW5kXG4gICAgYW5ub3VuY2VUaW1lciA9IHNldFRpbWVvdXQoZnVuY3Rpb24oKSB7XG4gICAgICB2YXIgZGF0YSA9IGV4dGVuZCh7IHJvb206IHJvb20gfSwgcHJvZmlsZSk7XG5cbiAgICAgIC8vIGFubm91bmNlIGFuZCBlbWl0IHRoZSBsb2NhbCBhbm5vdW5jZSBldmVudFxuICAgICAgc2lnbmFsbGVyLmFubm91bmNlKGRhdGEpO1xuICAgICAgYW5ub3VuY2VkID0gdHJ1ZTtcbiAgICB9LCAwKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGNvbm5lY3QoaWQsIGNvbm5lY3RPcHRzKSB7XG4gICAgZGVidWcoJ2Nvbm5lY3RpbmcgdG8gJyArIGlkKTtcbiAgICBpZiAoIWlkKSByZXR1cm4gZGVidWcoJ2ludmFsaWQgdGFyZ2V0IHBlZXIgSUQnKTtcbiAgICBpZiAocGVuZGluZ1tpZF0pIHtcbiAgICAgIHJldHVybiBkZWJ1ZygnYSBjb25uZWN0aW9uIGlzIGFscmVhZHkgcGVuZGluZyBmb3IgJyArIGlkICsgJywgYXMgb2YgJyArIChEYXRlLm5vdygpIC0gcGVuZGluZ1tpZF0pICsgJ21zIGFnbycpO1xuICAgIH1cbiAgICBjb25uZWN0T3B0cyA9IGNvbm5lY3RPcHRzIHx8IHt9O1xuXG4gICAgdmFyIHNjaGVtZSA9IHNjaGVtZXMuZ2V0KGNvbm5lY3RPcHRzLnNjaGVtZSwgdHJ1ZSk7XG4gICAgdmFyIGRhdGEgPSBnZXRQZWVyRGF0YShpZCk7XG4gICAgdmFyIHBjO1xuICAgIHZhciBtb25pdG9yO1xuICAgIHZhciBjYWxsO1xuXG4gICAgLy8gaWYgdGhlIHJvb20gaXMgbm90IGEgbWF0Y2gsIGFib3J0XG4gICAgaWYgKGRhdGEucm9vbSAhPT0gcm9vbSkge1xuICAgICAgcmV0dXJuIGRlYnVnKCdtaXNtYXRjaGluZyByb29tLCBleHBlY3RlZDogJyArIHJvb20gKyAnLCBnb3Q6ICcgKyAoZGF0YSAmJiBkYXRhLnJvb20pKTtcbiAgICB9XG4gICAgaWYgKGRhdGEuaWQgIT09IGlkKSB7XG4gICAgICByZXR1cm4gZGVidWcoJ21pc21hdGNoaW5nIGlkcywgZXhwZWN0ZWQ6ICcgKyBpZCArICcsIGdvdDogJyArIGRhdGEuaWQpO1xuICAgIH1cbiAgICBwZW5kaW5nW2lkXSA9IERhdGUubm93KCk7XG5cbiAgICAvLyBlbmQgYW55IGNhbGwgdG8gdGhpcyBpZCBzbyB3ZSBrbm93IHdlIGFyZSBzdGFydGluZyBmcmVzaFxuICAgIGNhbGxzLmVuZChpZCk7XG5cbiAgICBzaWduYWxsZXIoJ3BlZXI6cHJlcGFyZScsIGlkLCBkYXRhLCBzY2hlbWUpO1xuXG4gICAgZnVuY3Rpb24gY2xlYXJQZW5kaW5nKG1zZykge1xuICAgICAgZGVidWcoJ2Nvbm5lY3Rpb24gZm9yICcgKyBpZCArICcgaXMgbm8gbG9uZ2VyIHBlbmRpbmcgWycgKyAobXNnIHx8ICdubyByZWFzb24nKSArICddLCBjb25uZWN0IGF2YWlsYWJsZSBhZ2FpbicpO1xuICAgICAgaWYgKHBlbmRpbmdbaWRdKSB7XG4gICAgICAgIGRlbGV0ZSBwZW5kaW5nW2lkXTtcbiAgICAgIH1cbiAgICAgIGlmIChyZWNvbm5lY3RpbmdbaWRdKSB7XG4gICAgICAgIGRlbGV0ZSByZWNvbm5lY3RpbmdbaWRdO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIFJlZ2VuZXJhdGUgSUNFIHNlcnZlcnMgKG9yIHVzZSBleGlzdGluZyBjYWNoZWQgSUNFKVxuICAgIGdlbmVyYXRlSWNlU2VydmVycyhleHRlbmQoe3RhcmdldFBlZXI6IGlkfSwgb3B0cywgKHNjaGVtZSB8fCB7fSkuY29ubmVjdGlvbiksIGZ1bmN0aW9uKGVyciwgaWNlU2VydmVycykge1xuICAgICAgaWYgKGVycikge1xuICAgICAgICBzaWduYWxsZXIoJ2ljZWdlbmVyYXRpb246ZXJyb3InLCBpZCwgc2NoZW1lICYmIHNjaGVtZS5pZCwgZXJyKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHNpZ25hbGxlcigncGVlcjppY2VzZXJ2ZXJzJywgaWQsIHNjaGVtZSAmJiBzY2hlbWUuaWQsIGljZVNlcnZlcnMgfHwgW10pO1xuICAgICAgfVxuXG4gICAgICAvLyBjcmVhdGUgYSBwZWVyIGNvbm5lY3Rpb25cbiAgICAgIC8vIGljZVNlcnZlcnMgdGhhdCBoYXZlIGJlZW4gY3JlYXRlZCB1c2luZyBnZW5pY2UgdGFraW5nIHByZWNlbmRlbmNlXG4gICAgICBwYyA9IHJ0Yy5jcmVhdGVDb25uZWN0aW9uKFxuICAgICAgICBleHRlbmQoe30sIG9wdHMsIHsgaWNlU2VydmVyczogaWNlU2VydmVycyB9KSxcbiAgICAgICAgKG9wdHMgfHwge30pLmNvbnN0cmFpbnRzXG4gICAgICApO1xuXG4gICAgICBzaWduYWxsZXIoJ3BlZXI6Y29ubmVjdCcsIGlkLCBwYywgZGF0YSk7XG5cbiAgICAgIC8vIGFkZCB0aGlzIGNvbm5lY3Rpb24gdG8gdGhlIGNhbGxzIGxpc3RcbiAgICAgIGNhbGwgPSBjYWxscy5jcmVhdGUoaWQsIHBjLCBkYXRhKTtcblxuICAgICAgLy8gYWRkIHRoZSBsb2NhbCBzdHJlYW1zXG4gICAgICBsb2NhbFN0cmVhbXMuZm9yRWFjaChmdW5jdGlvbihzdHJlYW0pIHtcbiAgICAgICAgcGMuYWRkU3RyZWFtKHN0cmVhbSk7XG4gICAgICB9KTtcblxuICAgICAgLy8gYWRkIHRoZSBkYXRhIGNoYW5uZWxzXG4gICAgICAvLyBkbyB0aGlzIGRpZmZlcmVudGx5IGJhc2VkIG9uIHdoZXRoZXIgdGhlIGNvbm5lY3Rpb24gaXMgYVxuICAgICAgLy8gbWFzdGVyIG9yIGEgc2xhdmUgY29ubmVjdGlvblxuICAgICAgaWYgKHNpZ25hbGxlci5pc01hc3RlcihpZCkpIHtcbiAgICAgICAgZGVidWcoJ2lzIG1hc3RlciwgY3JlYXRpbmcgZGF0YSBjaGFubmVsczogJywgT2JqZWN0LmtleXMoY2hhbm5lbHMpKTtcblxuICAgICAgICAvLyBjcmVhdGUgdGhlIGNoYW5uZWxzXG4gICAgICAgIE9iamVjdC5rZXlzKGNoYW5uZWxzKS5mb3JFYWNoKGZ1bmN0aW9uKGxhYmVsKSB7XG4gICAgICAgICBnb3RQZWVyQ2hhbm5lbChwYy5jcmVhdGVEYXRhQ2hhbm5lbChsYWJlbCwgY2hhbm5lbHNbbGFiZWxdKSwgcGMsIGRhdGEpO1xuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICAgIGVsc2Uge1xuICAgICAgICBwYy5vbmRhdGFjaGFubmVsID0gZnVuY3Rpb24oZXZ0KSB7XG4gICAgICAgICAgdmFyIGNoYW5uZWwgPSBldnQgJiYgZXZ0LmNoYW5uZWw7XG5cbiAgICAgICAgICAvLyBpZiB3ZSBoYXZlIG5vIGNoYW5uZWwsIGFib3J0XG4gICAgICAgICAgaWYgKCEgY2hhbm5lbCkge1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGlmIChjaGFubmVsc1tjaGFubmVsLmxhYmVsXSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICBnb3RQZWVyQ2hhbm5lbChjaGFubmVsLCBwYywgZ2V0UGVlckRhdGEoaWQpKTtcbiAgICAgICAgICB9XG4gICAgICAgIH07XG4gICAgICB9XG5cbiAgICAgIC8vIGNvdXBsZSB0aGUgY29ubmVjdGlvbnNcbiAgICAgIGRlYnVnKCdjb3VwbGluZyAnICsgc2lnbmFsbGVyLmlkICsgJyB0byAnICsgaWQpO1xuICAgICAgbW9uaXRvciA9IHJ0Yy5jb3VwbGUocGMsIGlkLCBzaWduYWxsZXIsIGV4dGVuZCh7fSwgb3B0cywge1xuICAgICAgICBsb2dnZXI6IG1idXMoJ3BjLicgKyBpZCwgc2lnbmFsbGVyKVxuICAgICAgfSkpO1xuXG4gICAgICAvLyBBcHBseSB0aGUgbW9uaXRvciB0byB0aGUgY2FsbFxuICAgICAgY2FsbC5tb25pdG9yID0gbW9uaXRvcjtcblxuICAgICAgLy8gb25jZSBhY3RpdmUsIHRyaWdnZXIgdGhlIHBlZXIgY29ubmVjdCBldmVudFxuICAgICAgbW9uaXRvci5vbmNlKCdjb25uZWN0ZWQnLCBmdW5jdGlvbigpIHtcbiAgICAgICAgY2xlYXJQZW5kaW5nKCdjb25uZWN0ZWQgc3VjY2Vzc2Z1bGx5Jyk7XG4gICAgICAgIGNhbGxzLnN0YXJ0KGlkLCBwYywgZGF0YSk7XG4gICAgICB9KTtcbiAgICAgIG1vbml0b3Iub25jZSgnY2xvc2VkJywgZnVuY3Rpb24oKSB7XG4gICAgICAgIGNsZWFyUGVuZGluZygnY2xvc2VkJyk7XG4gICAgICAgIGNhbGxzLmVuZChpZCk7XG4gICAgICB9KTtcbiAgICAgIG1vbml0b3Iub25jZSgnYWJvcnRlZCcsIGZ1bmN0aW9uKCkge1xuICAgICAgICBjbGVhclBlbmRpbmcoJ2Fib3J0ZWQnKTtcbiAgICAgIH0pO1xuICAgICAgbW9uaXRvci5vbmNlKCdmYWlsZWQnLCBmdW5jdGlvbigpIHtcbiAgICAgICAgY2xlYXJQZW5kaW5nKCdmYWlsZWQnKTtcbiAgICAgICAgY2FsbHMuZmFpbChpZCk7XG4gICAgICB9KTtcblxuICAgICAgLy8gVGhlIGZvbGxvd2luZyBzdGF0ZXMgYXJlIGludGVybWVkaWF0ZSBzdGF0ZXMgYmFzZWQgb24gdGhlIGRpc2Nvbm5lY3Rpb24gdGltZXJcbiAgICAgIG1vbml0b3Iub25jZSgnZmFpbGluZycsIGNhbGxzLmZhaWxpbmcuYmluZChudWxsLCBpZCkpO1xuICAgICAgbW9uaXRvci5vbmNlKCdyZWNvdmVyZWQnLCBjYWxscy5yZWNvdmVyZWQuYmluZChudWxsLCBpZCkpO1xuXG4gICAgICAvLyBGaXJlIHRoZSBjb3VwbGUgZXZlbnRcbiAgICAgIHNpZ25hbGxlcigncGVlcjpjb3VwbGUnLCBpZCwgcGMsIGRhdGEsIG1vbml0b3IpO1xuXG4gICAgICAvLyBpZiB3ZSBhcmUgdGhlIG1hc3RlciBjb25ubmVjdGlvbiwgY3JlYXRlIHRoZSBvZmZlclxuICAgICAgLy8gTk9URTogdGhpcyBvbmx5IHJlYWxseSBmb3IgdGhlIHNha2Ugb2YgcG9saXRlbmVzcywgYXMgcnRjIGNvdXBsZVxuICAgICAgLy8gaW1wbGVtZW50YXRpb24gaGFuZGxlcyB0aGUgc2xhdmUgYXR0ZW1wdGluZyB0byBjcmVhdGUgYW4gb2ZmZXJcbiAgICAgIGlmIChzaWduYWxsZXIuaXNNYXN0ZXIoaWQpKSB7XG4gICAgICAgIG1vbml0b3IuY3JlYXRlT2ZmZXIoKTtcbiAgICAgIH1cblxuICAgICAgc2lnbmFsbGVyKCdwZWVyOnByZXBhcmVkJywgaWQpO1xuICAgIH0pO1xuICB9XG5cbiAgZnVuY3Rpb24gZ2V0QWN0aXZlQ2FsbChwZWVySWQpIHtcbiAgICB2YXIgY2FsbCA9IGNhbGxzLmdldChwZWVySWQpO1xuXG4gICAgaWYgKCEgY2FsbCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdObyBhY3RpdmUgY2FsbCBmb3IgcGVlcjogJyArIHBlZXJJZCk7XG4gICAgfVxuXG4gICAgcmV0dXJuIGNhbGw7XG4gIH1cblxuICBmdW5jdGlvbiBnb3RQZWVyQ2hhbm5lbChjaGFubmVsLCBwYywgZGF0YSkge1xuICAgIHZhciBjaGFubmVsTW9uaXRvcjtcbiAgICB2YXIgY2hhbm5lbENvbm5lY3Rpb25UaW1lcjtcblxuICAgIGZ1bmN0aW9uIGNoYW5uZWxSZWFkeSgpIHtcbiAgICAgIHZhciBjYWxsID0gY2FsbHMuZ2V0KGRhdGEuaWQpO1xuICAgICAgdmFyIGFyZ3MgPSBbIGRhdGEuaWQsIGNoYW5uZWwsIGRhdGEsIHBjIF07XG5cbiAgICAgIC8vIGRlY291cGxlIHRoZSBjaGFubmVsLm9ub3BlbiBsaXN0ZW5lclxuICAgICAgZGVidWcoJ3JlcG9ydGluZyBjaGFubmVsIFwiJyArIGNoYW5uZWwubGFiZWwgKyAnXCIgcmVhZHksIGhhdmUgY2FsbDogJyArICghIWNhbGwpKTtcbiAgICAgIGNsZWFySW50ZXJ2YWwoY2hhbm5lbE1vbml0b3IpO1xuICAgICAgY2xlYXJUaW1lb3V0KGNoYW5uZWxDb25uZWN0aW9uVGltZXIpO1xuICAgICAgY2hhbm5lbC5vbm9wZW4gPSBudWxsO1xuXG4gICAgICAvLyBzYXZlIHRoZSBjaGFubmVsXG4gICAgICBpZiAoY2FsbCkge1xuICAgICAgICBjYWxsLmNoYW5uZWxzLnNldChjaGFubmVsLmxhYmVsLCBjaGFubmVsKTtcbiAgICAgIH1cblxuICAgICAgLy8gdHJpZ2dlciB0aGUgJWNoYW5uZWwubGFiZWwlOm9wZW4gZXZlbnRcbiAgICAgIGRlYnVnKCd0cmlnZ2VyaW5nIGNoYW5uZWw6b3BlbmVkIGV2ZW50cyBmb3IgY2hhbm5lbDogJyArIGNoYW5uZWwubGFiZWwpO1xuXG4gICAgICAvLyBlbWl0IHRoZSBwbGFpbiBjaGFubmVsOm9wZW5lZCBldmVudFxuICAgICAgc2lnbmFsbGVyLmFwcGx5KHNpZ25hbGxlciwgWydjaGFubmVsOm9wZW5lZCddLmNvbmNhdChhcmdzKSk7XG5cbiAgICAgIC8vIGVtaXQgdGhlIGNoYW5uZWw6b3BlbmVkOiVsYWJlbCUgZXZlXG4gICAgICBzaWduYWxsZXIuYXBwbHkoXG4gICAgICAgIHNpZ25hbGxlcixcbiAgICAgICAgWydjaGFubmVsOm9wZW5lZDonICsgY2hhbm5lbC5sYWJlbF0uY29uY2F0KGFyZ3MpXG4gICAgICApO1xuICAgIH1cblxuICAgIC8vIElmIHRoZSBjaGFubmVsIGhhcyBmYWlsZWQgdG8gY3JlYXRlIGZvciBzb21lIHJlYXNvbiwgcmVjcmVhdGUgdGhlIGNoYW5uZWxcbiAgICBmdW5jdGlvbiByZWNyZWF0ZUNoYW5uZWwoKSB7XG4gICAgICBkZWJ1ZygncmVjcmVhdGluZyBkYXRhIGNoYW5uZWw6ICcgKyBjaGFubmVsLmxhYmVsKTtcbiAgICAgIC8vIENsZWFyIHRpbWVyc1xuICAgICAgY2xlYXJJbnRlcnZhbChjaGFubmVsTW9uaXRvcik7XG4gICAgICBjbGVhclRpbWVvdXQoY2hhbm5lbENvbm5lY3Rpb25UaW1lcik7XG5cbiAgICAgIC8vIEZvcmNlIHRoZSBjaGFubmVsIHRvIGNsb3NlIGlmIGl0IGlzIGluIGFuIG9wZW4gc3RhdGVcbiAgICAgIGlmIChbJ2Nvbm5lY3RpbmcnLCAnb3BlbiddLmluZGV4T2YoY2hhbm5lbC5yZWFkeVN0YXRlKSAhPT0gLTEpIHtcbiAgICAgICAgY2hhbm5lbC5jbG9zZSgpO1xuICAgICAgfVxuXG4gICAgICAvLyBSZWNyZWF0ZSB0aGUgY2hhbm5lbCB1c2luZyB0aGUgY2FjaGVkIG9wdGlvbnNcbiAgICAgIHNpZ25hbGxlci5jcmVhdGVEYXRhQ2hhbm5lbChjaGFubmVsLmxhYmVsLCBjaGFubmVsc1tjaGFubmVsLmxhYmVsXSlcbiAgICB9XG5cbiAgICBkZWJ1ZygnY2hhbm5lbCAnICsgY2hhbm5lbC5sYWJlbCArICcgZGlzY292ZXJlZCBmb3IgcGVlcjogJyArIGRhdGEuaWQpO1xuICAgIGlmIChjaGFubmVsLnJlYWR5U3RhdGUgPT09ICdvcGVuJykge1xuICAgICAgcmV0dXJuIGNoYW5uZWxSZWFkeSgpO1xuICAgIH1cblxuICAgIGRlYnVnKCdjaGFubmVsIG5vdCByZWFkeSwgY3VycmVudCBzdGF0ZSA9ICcgKyBjaGFubmVsLnJlYWR5U3RhdGUpO1xuICAgIGNoYW5uZWwub25vcGVuID0gY2hhbm5lbFJlYWR5O1xuXG4gICAgLy8gbW9uaXRvciB0aGUgY2hhbm5lbCBvcGVuIChkb24ndCB0cnVzdCB0aGUgY2hhbm5lbCBvcGVuIGV2ZW50IGp1c3QgeWV0KVxuICAgIGNoYW5uZWxNb25pdG9yID0gc2V0SW50ZXJ2YWwoZnVuY3Rpb24oKSB7XG4gICAgICBkZWJ1ZygnY2hlY2tpbmcgY2hhbm5lbCBzdGF0ZSwgY3VycmVudCBzdGF0ZSA9ICcgKyBjaGFubmVsLnJlYWR5U3RhdGUgKyAnLCBjb25uZWN0aW9uIHN0YXRlICcgKyBwYy5pY2VDb25uZWN0aW9uU3RhdGUpO1xuICAgICAgaWYgKGNoYW5uZWwucmVhZHlTdGF0ZSA9PT0gJ29wZW4nKSB7XG4gICAgICAgIGNoYW5uZWxSZWFkeSgpO1xuICAgICAgfVxuICAgICAgLy8gSWYgdGhlIHVuZGVybHlpbmcgY29ubmVjdGlvbiBoYXMgZmFpbGVkL2Nsb3NlZCwgdGhlbiB0ZXJtaW5hdGUgdGhlIG1vbml0b3JcbiAgICAgIGVsc2UgaWYgKFsnZmFpbGVkJywgJ2Nsb3NlZCddLmluZGV4T2YocGMuaWNlQ29ubmVjdGlvblN0YXRlKSAhPT0gLTEpIHtcbiAgICAgICAgZGVidWcoJ2Nvbm5lY3Rpb24gaGFzIHRlcm1pbmF0ZWQsIGNhbmNlbGxpbmcgY2hhbm5lbCBtb25pdG9yJyk7XG4gICAgICAgIGNsZWFySW50ZXJ2YWwoY2hhbm5lbE1vbml0b3IpO1xuICAgICAgICBjbGVhclRpbWVvdXQoY2hhbm5lbENvbm5lY3Rpb25UaW1lcik7XG4gICAgICB9XG4gICAgICAvLyBJZiB0aGUgY29ubmVjdGlvbiBoYXMgY29ubmVjdGVkLCBidXQgdGhlIGNoYW5uZWwgaXMgc3R1Y2sgaW4gdGhlIGNvbm5lY3Rpbmcgc3RhdGVcbiAgICAgIC8vIHN0YXJ0IGEgdGltZXIuIElmIHRoaXMgZXhwaXJlcywgdGhlbiB3ZSB3aWxsIGF0dGVtcHQgdG8gY3JlYXRlZCB0aGUgZGF0YSBjaGFubmVsXG4gICAgICBlbHNlIGlmIChwYy5pY2VDb25uZWN0aW9uU3RhdGUgPT09ICdjb25uZWN0ZWQnICYmIGNoYW5uZWwucmVhZHlTdGF0ZSA9PT0gJ2Nvbm5lY3RpbmcnICYmICFjaGFubmVsQ29ubmVjdGlvblRpbWVyKSB7XG4gICAgICAgIGNoYW5uZWxDb25uZWN0aW9uVGltZXIgPSBzZXRUaW1lb3V0KGZ1bmN0aW9uKCkge1xuICAgICAgICAgIGlmIChjaGFubmVsLnJlYWR5U3RhdGUgIT09ICdjb25uZWN0aW5nJykgcmV0dXJuO1xuICAgICAgICAgIHZhciBhcmdzID0gWyBkYXRhLmlkLCBjaGFubmVsLCBkYXRhLCBwYyBdO1xuXG4gICAgICAgICAgLy8gZW1pdCB0aGUgcGxhaW4gY2hhbm5lbDpmYWlsZWQgZXZlbnRcbiAgICAgICAgICBzaWduYWxsZXIuYXBwbHkoc2lnbmFsbGVyLCBbJ2NoYW5uZWw6ZmFpbGVkJ10uY29uY2F0KGFyZ3MpKTtcblxuICAgICAgICAgIC8vIGVtaXQgdGhlIGNoYW5uZWw6b3BlbmVkOiVsYWJlbCUgZXZlXG4gICAgICAgICAgc2lnbmFsbGVyLmFwcGx5KFxuICAgICAgICAgICAgc2lnbmFsbGVyLFxuICAgICAgICAgICAgWydjaGFubmVsOmZhaWxlZDonICsgY2hhbm5lbC5sYWJlbF0uY29uY2F0KGFyZ3MpXG4gICAgICAgICAgKTtcblxuICAgICAgICAgIC8vIFJlY3JlYXRlIHRoZSBjaGFubmVsXG4gICAgICAgICAgcmV0dXJuIHJlY3JlYXRlQ2hhbm5lbCgpO1xuICAgICAgICB9LCAob3B0cyB8fCB7fSkuY2hhbm5lbFRpbWVvdXQgfHwgMjAwMCk7XG4gICAgICB9XG5cbiAgICB9LCA1MDApO1xuICB9XG5cbiAgZnVuY3Rpb24gaW5pdFBsdWdpbigpIHtcbiAgICByZXR1cm4gcGx1Z2luICYmIHBsdWdpbi5pbml0KG9wdHMsIGZ1bmN0aW9uKGVycikge1xuICAgICAgaWYgKGVycikge1xuICAgICAgICByZXR1cm4gY29uc29sZS5lcnJvcignQ291bGQgbm90IGluaXRpYWxpemUgcGx1Z2luOiAnLCBlcnIpO1xuICAgICAgfVxuXG4gICAgICBwbHVnaW5SZWFkeSA9IHRydWU7XG4gICAgICBjaGVja1JlYWR5VG9Bbm5vdW5jZSgpO1xuICAgIH0pO1xuICB9XG5cbiAgZnVuY3Rpb24gaGFuZGxlTG9jYWxBbm5vdW5jZShkYXRhKSB7XG4gICAgLy8gaWYgd2Ugc2VuZCBhbiBhbm5vdW5jZSB3aXRoIGFuIHVwZGF0ZWQgcm9vbSB0aGVuIHVwZGF0ZSBvdXIgbG9jYWwgcm9vbSBuYW1lXG4gICAgaWYgKGRhdGEgJiYgdHlwZW9mIGRhdGEucm9vbSAhPSAndW5kZWZpbmVkJykge1xuICAgICAgcm9vbSA9IGRhdGEucm9vbTtcbiAgICB9XG4gIH1cblxuICBmdW5jdGlvbiBoYW5kbGVQZWVyRmlsdGVyKGlkLCBkYXRhKSB7XG4gICAgLy8gb25seSBjb25uZWN0IHdpdGggdGhlIHBlZXIgaWYgd2UgYXJlIHJlYWR5XG4gICAgZGF0YS5hbGxvdyA9IGRhdGEuYWxsb3cgJiYgKGxvY2FsU3RyZWFtcy5sZW5ndGggPj0gZXhwZWN0ZWRMb2NhbFN0cmVhbXMpO1xuICB9XG5cbiAgZnVuY3Rpb24gaGFuZGxlUGVlclVwZGF0ZShkYXRhKSB7XG4gICAgLy8gRG8gbm90IGFsbG93IHBlZXIgdXBkYXRlcyBpZiB3ZSBhcmUgbm90IGFubm91bmNlZFxuICAgIGlmICghYW5ub3VuY2VkKSByZXR1cm47XG5cbiAgICB2YXIgaWQgPSBkYXRhICYmIGRhdGEuaWQ7XG4gICAgdmFyIGFjdGl2ZUNhbGwgPSBpZCAmJiBjYWxscy5nZXQoaWQpO1xuXG4gICAgLy8gaWYgd2UgaGF2ZSByZWNlaXZlZCBhbiB1cGRhdGUgZm9yIGEgcGVlciB0aGF0IGhhcyBubyBhY3RpdmUgY2FsbHMsXG4gICAgLy8gYW5kIGlzIG5vdCBjdXJyZW50bHkgaW4gdGhlIHByb2Nlc3Mgb2Ygc2V0dGluZyB1cCBhIGNhbGxcbiAgICAvLyB0aGVuIHBhc3MgdGhpcyBvbnRvIHRoZSBhbm5vdW5jZSBoYW5kbGVyXG4gICAgaWYgKGlkICYmICghIGFjdGl2ZUNhbGwpICYmICFwZW5kaW5nW2lkXSAmJiAhcmVjb25uZWN0aW5nW2lkXSkge1xuICAgICAgZGVidWcoJ3JlY2VpdmVkIHBlZXIgdXBkYXRlIGZyb20gcGVlciAnICsgaWQgKyAnLCBubyBhY3RpdmUgY2FsbHMnKTtcbiAgICAgIHNpZ25hbGxlcigncGVlcjphdXRvcmVjb25uZWN0JywgaWQpO1xuICAgICAgcmV0dXJuIHNpZ25hbGxlci5yZWNvbm5lY3RUbyhpZCk7XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gaGFuZGxlUGVlckxlYXZlKGRhdGEpIHtcbiAgICB2YXIgaWQgPSBkYXRhICYmIGRhdGEuaWQ7XG4gICAgaWYgKGlkKSB7XG4gICAgICBkZWxldGUgcGVuZGluZ1tpZF07XG4gICAgICBjYWxscy5lbmQoaWQpO1xuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIGhhbmRsZVBlZXJDbG9zZShpZCkge1xuICAgIGlmICghYW5ub3VuY2VkKSByZXR1cm47XG4gICAgZGVsZXRlIHBlbmRpbmdbaWRdO1xuICAgIGRlYnVnKCdjYWxsIGhhcyBmcm9tICcgKyBzaWduYWxsZXIuaWQgKyAnIHRvICcgKyBpZCArICcgaGFzIGVuZGVkLCByZWFubm91bmNpbmcnKTtcbiAgICByZXR1cm4gc2lnbmFsbGVyLnByb2ZpbGUoKTtcbiAgfVxuXG4gIC8vIGlmIHRoZSByb29tIGlzIG5vdCBkZWZpbmVkLCB0aGVuIGdlbmVyYXRlIHRoZSByb29tIG5hbWVcbiAgaWYgKCEgcm9vbSkge1xuICAgIC8vIGlmIHRoZSBoYXNoIGlzIG5vdCBhc3NpZ25lZCwgdGhlbiBjcmVhdGUgYSByYW5kb20gaGFzaCB2YWx1ZVxuICAgIGlmICh0eXBlb2YgbG9jYXRpb24gIT0gJ3VuZGVmaW5lZCcgJiYgKCEgaGFzaCkpIHtcbiAgICAgIGhhc2ggPSBsb2NhdGlvbi5oYXNoID0gJycgKyAoTWF0aC5wb3coMiwgNTMpICogTWF0aC5yYW5kb20oKSk7XG4gICAgfVxuXG4gICAgcm9vbSA9IG5zICsgJyMnICsgaGFzaDtcbiAgfVxuXG4gIGlmIChkZWJ1Z2dpbmcpIHtcbiAgICBydGMubG9nZ2VyLmVuYWJsZS5hcHBseShydGMubG9nZ2VyLCBBcnJheS5pc0FycmF5KGRlYnVnKSA/IGRlYnVnZ2luZyA6IFsnKiddKTtcbiAgfVxuXG4gIHNpZ25hbGxlci5vbigncGVlcjphbm5vdW5jZScsIGZ1bmN0aW9uKGRhdGEpIHtcbiAgICBjb25uZWN0KGRhdGEuaWQsIHsgc2NoZW1lOiBkYXRhLnNjaGVtZSB9KTtcbiAgfSk7XG5cbiAgc2lnbmFsbGVyLm9uKCdwZWVyOnVwZGF0ZScsIGhhbmRsZVBlZXJVcGRhdGUpO1xuXG4gIHNpZ25hbGxlci5vbignbWVzc2FnZTpyZWNvbm5lY3QnLCBmdW5jdGlvbihkYXRhLCBzZW5kZXIsIG1lc3NhZ2UpIHtcbiAgICBkZWJ1ZygncmVjZWl2ZWQgcmVjb25uZWN0IG1lc3NhZ2UnKTtcblxuICAgIC8vIFNlbmRlciBhcmd1bWVudHMgYXJlIGFsd2F5cyBsYXN0XG4gICAgaWYgKCFtZXNzYWdlKSB7XG4gICAgICBtZXNzYWdlID0gc2VuZGVyO1xuICAgICAgc2VuZGVyID0gZGF0YTtcbiAgICAgIGRhdGEgPSB1bmRlZmluZWQ7XG4gICAgfVxuICAgIGlmICghc2VuZGVyLmlkKSByZXR1cm4gY29uc29sZS53YXJuKCdDb3VsZCBub3QgcmVjb25uZWN0LCBubyBzZW5kZXIgSUQnKTtcblxuICAgIC8vIEFib3J0IGFueSBjdXJyZW50IGNhbGxzXG4gICAgY2FsbHMuYWJvcnQoc2VuZGVyLmlkKTtcbiAgICBkZWxldGUgcmVjb25uZWN0aW5nW3NlbmRlci5pZF07XG4gICAgc2lnbmFsbGVyKCdwZWVyOnJlY29ubmVjdGluZycsIHNlbmRlci5pZCwgZGF0YSB8fCB7fSk7XG4gICAgY29ubmVjdChzZW5kZXIuaWQsIGRhdGEgfHwge30pO1xuXG4gICAgLy8gSWYgdGhpcyBpcyB0aGUgbWFzdGVyLCBlY2hvIHRoZSByZWNvbm5lY3Rpb24gYmFjayB0byB0aGUgcGVlciBpbnN0cnVjdGluZyB0aGF0XG4gICAgLy8gdGhlIHJlY29ubmVjdGlvbiBoYXMgYmVlbiBhY2NlcHRlZCBhbmQgdG8gY29ubmVjdFxuICAgIHZhciBpc01hc3RlciA9IHNpZ25hbGxlci5pc01hc3RlcihzZW5kZXIuaWQpO1xuICAgIGlmIChpc01hc3Rlcikge1xuICAgICAgc2lnbmFsbGVyLnRvKHNlbmRlci5pZCkuc2VuZCgnL3JlY29ubmVjdCcsIGRhdGEgfHwge30pO1xuICAgIH1cbiAgfSk7XG5cbiAgLyoqXG4gICAgIyMjIFF1aWNrY29ubmVjdCBCcm9hZGNhc3QgYW5kIERhdGEgQ2hhbm5lbCBIZWxwZXIgRnVuY3Rpb25zXG5cbiAgICBUaGUgZm9sbG93aW5nIGFyZSBmdW5jdGlvbnMgdGhhdCBhcmUgcGF0Y2hlZCBpbnRvIHRoZSBgcnRjLXNpZ25hbGxlcmBcbiAgICBpbnN0YW5jZSB0aGF0IG1ha2Ugd29ya2luZyB3aXRoIGFuZCBjcmVhdGluZyBmdW5jdGlvbmFsIFdlYlJUQyBhcHBsaWNhdGlvbnNcbiAgICBhIGxvdCBzaW1wbGVyLlxuXG4gICoqL1xuXG4gIC8qKlxuICAgICMjIyMgYWRkU3RyZWFtXG5cbiAgICBgYGBcbiAgICBhZGRTdHJlYW0oc3RyZWFtOk1lZGlhU3RyZWFtKSA9PiBxY1xuICAgIGBgYFxuXG4gICAgQWRkIHRoZSBzdHJlYW0gdG8gYWN0aXZlIGNhbGxzIGFuZCBhbHNvIHNhdmUgdGhlIHN0cmVhbSBzbyB0aGF0IGl0XG4gICAgY2FuIGJlIGFkZGVkIHRvIGZ1dHVyZSBjYWxscy5cblxuICAqKi9cbiAgc2lnbmFsbGVyLmJyb2FkY2FzdCA9IHNpZ25hbGxlci5hZGRTdHJlYW0gPSBmdW5jdGlvbihzdHJlYW0pIHtcbiAgICBsb2NhbFN0cmVhbXMucHVzaChzdHJlYW0pO1xuXG4gICAgLy8gaWYgd2UgaGF2ZSBhbnkgYWN0aXZlIGNhbGxzLCB0aGVuIGFkZCB0aGUgc3RyZWFtXG4gICAgY2FsbHMudmFsdWVzKCkuZm9yRWFjaChmdW5jdGlvbihkYXRhKSB7XG4gICAgICBkYXRhLnBjLmFkZFN0cmVhbShzdHJlYW0pO1xuICAgIH0pO1xuXG4gICAgY2hlY2tSZWFkeVRvQW5ub3VuY2UoKTtcbiAgICByZXR1cm4gc2lnbmFsbGVyO1xuICB9O1xuXG4gIC8qKlxuICAgICMjIyMgZW5kQ2FsbFxuXG4gICAgVGhlIGBlbmRDYWxsYCBmdW5jdGlvbiB0ZXJtaW5hdGVzIHRoZSBhY3RpdmUgY2FsbCB3aXRoIHRoZSBnaXZlbiBJRC5cbiAgICBJZiBhIGNhbGwgd2l0aCB0aGUgY2FsbCBJRCBkb2VzIG5vdCBleGlzdCBpdCB3aWxsIGRvIG5vdGhpbmcuXG4gICoqL1xuICBzaWduYWxsZXIuZW5kQ2FsbCA9IGNhbGxzLmVuZDtcblxuICAvKipcbiAgICAjIyMjIGVuZENhbGxzKClcblxuICAgIFRoZSBgZW5kQ2FsbHNgIGZ1bmN0aW9uIHRlcm1pbmF0ZXMgYWxsIHRoZSBhY3RpdmUgY2FsbHMgdGhhdCBoYXZlIGJlZW5cbiAgICBjcmVhdGVkIGluIHRoaXMgcXVpY2tjb25uZWN0IGluc3RhbmNlLiAgQ2FsbGluZyBgZW5kQ2FsbHNgIGRvZXMgbm90XG4gICAga2lsbCB0aGUgY29ubmVjdGlvbiB3aXRoIHRoZSBzaWduYWxsaW5nIHNlcnZlci5cblxuICAqKi9cbiAgc2lnbmFsbGVyLmVuZENhbGxzID0gZnVuY3Rpb24oKSB7XG4gICAgY2FsbHMua2V5cygpLmZvckVhY2goY2FsbHMuZW5kKTtcbiAgfTtcblxuICAvKipcbiAgICAjIyMjIGNsb3NlKClcblxuICAgIFRoZSBgY2xvc2VgIGZ1bmN0aW9uIHByb3ZpZGVzIGEgY29udmVuaWVudCB3YXkgb2YgY2xvc2luZyBhbGwgYXNzb2NpYXRlZFxuICAgIHBlZXIgY29ubmVjdGlvbnMuICBUaGlzIGZ1bmN0aW9uIHNpbXBseSB1c2VzIHRoZSBgZW5kQ2FsbHNgIGZ1bmN0aW9uIGFuZFxuICAgIHRoZSB1bmRlcmx5aW5nIGBsZWF2ZWAgZnVuY3Rpb24gb2YgdGhlIHNpZ25hbGxlciB0byBkbyBhIFwiZnVsbCBjbGVhbnVwXCJcbiAgICBvZiBhbGwgY29ubmVjdGlvbnMuXG4gICoqL1xuICBzaWduYWxsZXIuY2xvc2UgPSBmdW5jdGlvbigpIHtcbiAgICAvLyBXZSBhcmUgbm8gbG9uZ2VyIGFubm91bmNlZFxuICAgIGFubm91bmNlZCA9IGZhbHNlO1xuXG4gICAgLy8gUmVtb3ZlIGFueSBwZW5kaW5nIHVwZGF0ZSBhbm5vdWNlbWVudHNcbiAgICBpZiAodXBkYXRlVGltZXIpIGNsZWFyVGltZW91dCh1cGRhdGVUaW1lcik7XG5cbiAgICAvLyBDbGVhbnVwXG4gICAgc2lnbmFsbGVyLmVuZENhbGxzKCk7XG4gICAgc2lnbmFsbGVyLmxlYXZlKCk7XG4gIH07XG5cbiAgLyoqXG4gICAgIyMjIyBjcmVhdGVEYXRhQ2hhbm5lbChsYWJlbCwgY29uZmlnKVxuXG4gICAgUmVxdWVzdCB0aGF0IGEgZGF0YSBjaGFubmVsIHdpdGggdGhlIHNwZWNpZmllZCBgbGFiZWxgIGlzIGNyZWF0ZWQgb25cbiAgICB0aGUgcGVlciBjb25uZWN0aW9uLiAgV2hlbiB0aGUgZGF0YSBjaGFubmVsIGlzIG9wZW4gYW5kIGF2YWlsYWJsZSwgYW5cbiAgICBldmVudCB3aWxsIGJlIHRyaWdnZXJlZCB1c2luZyB0aGUgbGFiZWwgb2YgdGhlIGRhdGEgY2hhbm5lbC5cblxuICAgIEZvciBleGFtcGxlLCBpZiBhIG5ldyBkYXRhIGNoYW5uZWwgd2FzIHJlcXVlc3RlZCB1c2luZyB0aGUgZm9sbG93aW5nXG4gICAgY2FsbDpcblxuICAgIGBgYGpzXG4gICAgdmFyIHFjID0gcXVpY2tjb25uZWN0KCdodHRwczovL3N3aXRjaGJvYXJkLnJ0Yy5pby8nKS5jcmVhdGVEYXRhQ2hhbm5lbCgndGVzdCcpO1xuICAgIGBgYFxuXG4gICAgVGhlbiB3aGVuIHRoZSBkYXRhIGNoYW5uZWwgaXMgcmVhZHkgZm9yIHVzZSwgYSBgdGVzdDpvcGVuYCBldmVudCB3b3VsZFxuICAgIGJlIGVtaXR0ZWQgYnkgYHFjYC5cblxuICAqKi9cbiAgc2lnbmFsbGVyLmNyZWF0ZURhdGFDaGFubmVsID0gZnVuY3Rpb24obGFiZWwsIG9wdHMpIHtcbiAgICAvLyBjcmVhdGUgYSBjaGFubmVsIG9uIGFsbCBleGlzdGluZyBjYWxsc1xuICAgIGNhbGxzLmtleXMoKS5mb3JFYWNoKGZ1bmN0aW9uKHBlZXJJZCkge1xuICAgICAgdmFyIGNhbGwgPSBjYWxscy5nZXQocGVlcklkKTtcbiAgICAgIHZhciBkYztcblxuICAgICAgLy8gaWYgd2UgYXJlIHRoZSBtYXN0ZXIgY29ubmVjdGlvbiwgY3JlYXRlIHRoZSBkYXRhIGNoYW5uZWxcbiAgICAgIGlmIChjYWxsICYmIGNhbGwucGMgJiYgc2lnbmFsbGVyLmlzTWFzdGVyKHBlZXJJZCkpIHtcbiAgICAgICAgZGMgPSBjYWxsLnBjLmNyZWF0ZURhdGFDaGFubmVsKGxhYmVsLCBvcHRzKTtcbiAgICAgICAgZ290UGVlckNoYW5uZWwoZGMsIGNhbGwucGMsIGdldFBlZXJEYXRhKHBlZXJJZCkpO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgLy8gc2F2ZSB0aGUgZGF0YSBjaGFubmVsIG9wdHMgaW4gdGhlIGxvY2FsIGNoYW5uZWxzIGRpY3Rpb25hcnlcbiAgICBjaGFubmVsc1tsYWJlbF0gPSBvcHRzIHx8IG51bGw7XG5cbiAgICByZXR1cm4gc2lnbmFsbGVyO1xuICB9O1xuXG4gIC8qKlxuICAgICMjIyMgam9pbigpXG5cbiAgICBUaGUgYGpvaW5gIGZ1bmN0aW9uIGlzIHVzZWQgd2hlbiBgbWFudWFsSm9pbmAgaXMgc2V0IHRvIHRydWUgd2hlbiBjcmVhdGluZ1xuICAgIGEgcXVpY2tjb25uZWN0IGluc3RhbmNlLiAgQ2FsbCB0aGUgYGpvaW5gIGZ1bmN0aW9uIG9uY2UgeW91IGFyZSByZWFkeSB0b1xuICAgIGpvaW4gdGhlIHNpZ25hbGxpbmcgc2VydmVyIGFuZCBpbml0aWF0ZSBjb25uZWN0aW9ucyB3aXRoIG90aGVyIHBlb3BsZS5cblxuICAqKi9cbiAgc2lnbmFsbGVyLmpvaW4gPSBmdW5jdGlvbigpIHtcbiAgICBhbGxvd0pvaW4gPSB0cnVlO1xuICAgIGNoZWNrUmVhZHlUb0Fubm91bmNlKCk7XG4gIH07XG5cbiAgLyoqXG4gICAgIyMjIyBgZ2V0KG5hbWUpYFxuXG4gICAgVGhlIGBnZXRgIGZ1bmN0aW9uIHJldHVybnMgdGhlIHByb3BlcnR5IHZhbHVlIGZvciB0aGUgc3BlY2lmaWVkIHByb3BlcnR5IG5hbWUuXG4gICoqL1xuICBzaWduYWxsZXIuZ2V0ID0gZnVuY3Rpb24obmFtZSkge1xuICAgIHJldHVybiBwcm9maWxlW25hbWVdO1xuICB9O1xuXG4gIC8qKlxuICAgICMjIyMgYGdldExvY2FsU3RyZWFtcygpYFxuXG4gICAgUmV0dXJuIGEgY29weSBvZiB0aGUgbG9jYWwgc3RyZWFtcyB0aGF0IGhhdmUgY3VycmVudGx5IGJlZW4gY29uZmlndXJlZFxuICAqKi9cbiAgc2lnbmFsbGVyLmdldExvY2FsU3RyZWFtcyA9IGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiBbXS5jb25jYXQobG9jYWxTdHJlYW1zKTtcbiAgfTtcblxuICAvKipcbiAgICAjIyMjIHJlYWN0aXZlKClcblxuICAgIEZsYWcgdGhhdCB0aGlzIHNlc3Npb24gd2lsbCBiZSBhIHJlYWN0aXZlIGNvbm5lY3Rpb24uXG5cbiAgKiovXG4gIHNpZ25hbGxlci5yZWFjdGl2ZSA9IGZ1bmN0aW9uKCkge1xuICAgIC8vIGFkZCB0aGUgcmVhY3RpdmUgZmxhZ1xuICAgIG9wdHMgPSBvcHRzIHx8IHt9O1xuICAgIG9wdHMucmVhY3RpdmUgPSB0cnVlO1xuXG4gICAgLy8gY2hhaW5cbiAgICByZXR1cm4gc2lnbmFsbGVyO1xuICB9O1xuXG4gIC8qKlxuICAgICMjIyMgcmVnaXN0ZXJTY2hlbWVcblxuICAgIFJlZ2lzdGVycyBhIGNvbm5lY3Rpb24gc2NoZW1lIGZvciB1c2UsIGFuZCBjaGVjayBpdCBmb3IgdmFsaWRpdHlcbiAgICoqL1xuICBzaWduYWxsZXIucmVnaXN0ZXJTY2hlbWUgPSBzY2hlbWVzLmFkZDtcblxuICAvKipcbiAgICMjIyMgZ2V0U2NoZSxlXG5cbiAgIFJldHVybnMgdGhlIGNvbm5lY3Rpb24gc2hlbWUgZ2l2ZW4gYnkgSURcbiAgKiovXG4gIHNpZ25hbGxlci5nZXRTY2hlbWUgPSBzY2hlbWVzLmdldDtcblxuICAvKipcbiAgICAjIyMjIHJlbW92ZVN0cmVhbVxuXG4gICAgYGBgXG4gICAgcmVtb3ZlU3RyZWFtKHN0cmVhbTpNZWRpYVN0cmVhbSlcbiAgICBgYGBcblxuICAgIFJlbW92ZSB0aGUgc3BlY2lmaWVkIHN0cmVhbSBmcm9tIGJvdGggdGhlIGxvY2FsIHN0cmVhbXMgdGhhdCBhcmUgdG9cbiAgICBiZSBjb25uZWN0ZWQgdG8gbmV3IHBlZXJzLCBhbmQgYWxzbyBmcm9tIGFueSBhY3RpdmUgY2FsbHMuXG5cbiAgKiovXG4gIHNpZ25hbGxlci5yZW1vdmVTdHJlYW0gPSBmdW5jdGlvbihzdHJlYW0pIHtcbiAgICB2YXIgbG9jYWxJbmRleCA9IGxvY2FsU3RyZWFtcy5pbmRleE9mKHN0cmVhbSk7XG5cbiAgICAvLyByZW1vdmUgdGhlIHN0cmVhbSBmcm9tIGFueSBhY3RpdmUgY2FsbHNcbiAgICBjYWxscy52YWx1ZXMoKS5mb3JFYWNoKGZ1bmN0aW9uKGNhbGwpIHtcblxuICAgICAgLy8gSWYgYFJUQ1BlZXJDb25uZWN0aW9uLnJlbW92ZVRyYWNrYCBleGlzdHMgKEZpcmVmb3gpLCB0aGVuIHVzZSB0aGF0XG4gICAgICAvLyBhcyBgUlRDUGVlckNvbm5lY3Rpb24ucmVtb3ZlU3RyZWFtYCBpcyBub3Qgc3VwcG9ydGVkXG4gICAgICBpZiAoY2FsbC5wYy5yZW1vdmVUcmFjaykge1xuICAgICAgICBzdHJlYW0uZ2V0VHJhY2tzKCkuZm9yRWFjaChmdW5jdGlvbih0cmFjaykge1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjYWxsLnBjLnJlbW92ZVRyYWNrKHRyYWNrKTtcbiAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAvLyBXaGVuIHVzaW5nIExvY2FsTWVkaWFTdHJlYW1UcmFja3MsIHRoaXMgc2VlbXMgdG8gdGhyb3cgYW4gZXJyb3IgZHVlIHRvXG4gICAgICAgICAgICAvLyBMb2NhbE1lZGlhU3RyZWFtVHJhY2sgbm90IGltcGxlbWVudGluZyB0aGUgUlRDUnRwU2VuZGVyIGludGVmYWNlLlxuICAgICAgICAgICAgLy8gV2l0aG91dCBgcmVtb3ZlU3RyZWFtYCBhbmQgd2l0aCBgcmVtb3ZlVHJhY2tgIG5vdCBhbGxvd2luZyBmb3IgbG9jYWwgc3RyZWFtXG4gICAgICAgICAgICAvLyByZW1vdmFsLCB0aGlzIG5lZWRzIHNvbWUgdGhvdWdodCB3aGVuIGRlYWxpbmcgd2l0aCBGRiByZW5lZ290aWF0aW9uXG4gICAgICAgICAgICBjb25zb2xlLmVycm9yKCdFcnJvciByZW1vdmluZyBtZWRpYSB0cmFjaycsIGUpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgICAvLyBPdGhlcndpc2Ugd2UganVzdCB1c2UgYFJUQ1BlZXJDb25uZWN0aW9uLnJlbW92ZVN0cmVhbWBcbiAgICAgIGVsc2Uge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNhbGwucGMucmVtb3ZlU3RyZWFtKHN0cmVhbSk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICBjb25zb2xlLmVycm9yKCdGYWlsZWQgdG8gcmVtb3ZlIG1lZGlhIHN0cmVhbScsIGUpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICAvLyByZW1vdmUgdGhlIHN0cmVhbSBmcm9tIHRoZSBsb2NhbFN0cmVhbXMgYXJyYXlcbiAgICBpZiAobG9jYWxJbmRleCA+PSAwKSB7XG4gICAgICBsb2NhbFN0cmVhbXMuc3BsaWNlKGxvY2FsSW5kZXgsIDEpO1xuICAgIH1cblxuICAgIHJldHVybiBzaWduYWxsZXI7XG4gIH07XG5cbiAgLyoqXG4gICAgIyMjIyByZXF1ZXN0Q2hhbm5lbFxuXG4gICAgYGBgXG4gICAgcmVxdWVzdENoYW5uZWwodGFyZ2V0SWQsIGxhYmVsLCBjYWxsYmFjaylcbiAgICBgYGBcblxuICAgIFRoaXMgaXMgYSBmdW5jdGlvbiB0aGF0IGNhbiBiZSB1c2VkIHRvIHJlc3BvbmQgdG8gcmVtb3RlIHBlZXJzIHN1cHBseWluZ1xuICAgIGEgZGF0YSBjaGFubmVsIGFzIHBhcnQgb2YgdGhlaXIgY29uZmlndXJhdGlvbi4gIEFzIHBlciB0aGUgYHJlY2VpdmVTdHJlYW1gXG4gICAgZnVuY3Rpb24gdGhpcyBmdW5jdGlvbiB3aWxsIGVpdGhlciBmaXJlIHRoZSBjYWxsYmFjayBpbW1lZGlhdGVseSBpZiB0aGVcbiAgICBjaGFubmVsIGlzIGFscmVhZHkgYXZhaWxhYmxlLCBvciBvbmNlIHRoZSBjaGFubmVsIGhhcyBiZWVuIGRpc2NvdmVyZWQgb25cbiAgICB0aGUgY2FsbC5cblxuICAqKi9cbiAgc2lnbmFsbGVyLnJlcXVlc3RDaGFubmVsID0gZnVuY3Rpb24odGFyZ2V0SWQsIGxhYmVsLCBjYWxsYmFjaykge1xuICAgIHZhciBjYWxsID0gZ2V0QWN0aXZlQ2FsbCh0YXJnZXRJZCk7XG4gICAgdmFyIGNoYW5uZWwgPSBjYWxsICYmIGNhbGwuY2hhbm5lbHMuZ2V0KGxhYmVsKTtcblxuICAgIC8vIGlmIHdlIGhhdmUgdGhlbiBjaGFubmVsIHRyaWdnZXIgdGhlIGNhbGxiYWNrIGltbWVkaWF0ZWx5XG4gICAgaWYgKGNoYW5uZWwpIHtcbiAgICAgIGNhbGxiYWNrKG51bGwsIGNoYW5uZWwpO1xuICAgICAgcmV0dXJuIHNpZ25hbGxlcjtcbiAgICB9XG5cbiAgICAvLyBpZiBub3QsIHdhaXQgZm9yIGl0XG4gICAgc2lnbmFsbGVyLm9uY2UoJ2NoYW5uZWw6b3BlbmVkOicgKyBsYWJlbCwgZnVuY3Rpb24oaWQsIGRjKSB7XG4gICAgICBjYWxsYmFjayhudWxsLCBkYyk7XG4gICAgfSk7XG5cbiAgICByZXR1cm4gc2lnbmFsbGVyO1xuICB9O1xuXG4gIC8qKlxuICAgICMjIyMgcmVxdWVzdFN0cmVhbVxuXG4gICAgYGBgXG4gICAgcmVxdWVzdFN0cmVhbSh0YXJnZXRJZCwgaWR4LCBjYWxsYmFjaylcbiAgICBgYGBcblxuICAgIFVzZWQgdG8gcmVxdWVzdCBhIHJlbW90ZSBzdHJlYW0gZnJvbSBhIHF1aWNrY29ubmVjdCBpbnN0YW5jZS4gSWYgdGhlXG4gICAgc3RyZWFtIGlzIGFscmVhZHkgYXZhaWxhYmxlIGluIHRoZSBjYWxscyByZW1vdGUgc3RyZWFtcywgdGhlbiB0aGUgY2FsbGJhY2tcbiAgICB3aWxsIGJlIHRyaWdnZXJlZCBpbW1lZGlhdGVseSwgb3RoZXJ3aXNlIHRoaXMgZnVuY3Rpb24gd2lsbCBtb25pdG9yXG4gICAgYHN0cmVhbTphZGRlZGAgZXZlbnRzIGFuZCB3YWl0IGZvciBhIG1hdGNoLlxuXG4gICAgSW4gdGhlIGNhc2UgdGhhdCBhbiB1bmtub3duIHRhcmdldCBpcyByZXF1ZXN0ZWQsIHRoZW4gYW4gZXhjZXB0aW9uIHdpbGxcbiAgICBiZSB0aHJvd24uXG4gICoqL1xuICBzaWduYWxsZXIucmVxdWVzdFN0cmVhbSA9IGZ1bmN0aW9uKHRhcmdldElkLCBpZHgsIGNhbGxiYWNrKSB7XG4gICAgdmFyIGNhbGwgPSBnZXRBY3RpdmVDYWxsKHRhcmdldElkKTtcbiAgICB2YXIgc3RyZWFtO1xuXG4gICAgZnVuY3Rpb24gd2FpdEZvclN0cmVhbShwZWVySWQpIHtcbiAgICAgIGlmIChwZWVySWQgIT09IHRhcmdldElkKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgLy8gZ2V0IHRoZSBzdHJlYW1cbiAgICAgIHN0cmVhbSA9IGNhbGwucGMuZ2V0UmVtb3RlU3RyZWFtcygpW2lkeF07XG5cbiAgICAgIC8vIGlmIHdlIGhhdmUgdGhlIHN0cmVhbSwgdGhlbiByZW1vdmUgdGhlIGxpc3RlbmVyIGFuZCB0cmlnZ2VyIHRoZSBjYlxuICAgICAgaWYgKHN0cmVhbSkge1xuICAgICAgICBzaWduYWxsZXIucmVtb3ZlTGlzdGVuZXIoJ3N0cmVhbTphZGRlZCcsIHdhaXRGb3JTdHJlYW0pO1xuICAgICAgICBjYWxsYmFjayhudWxsLCBzdHJlYW0pO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIGxvb2sgZm9yIHRoZSBzdHJlYW0gaW4gdGhlIHJlbW90ZSBzdHJlYW1zIG9mIHRoZSBjYWxsXG4gICAgc3RyZWFtID0gY2FsbC5wYy5nZXRSZW1vdGVTdHJlYW1zKClbaWR4XTtcblxuICAgIC8vIGlmIHdlIGZvdW5kIHRoZSBzdHJlYW0gdGhlbiB0cmlnZ2VyIHRoZSBjYWxsYmFja1xuICAgIGlmIChzdHJlYW0pIHtcbiAgICAgIGNhbGxiYWNrKG51bGwsIHN0cmVhbSk7XG4gICAgICByZXR1cm4gc2lnbmFsbGVyO1xuICAgIH1cblxuICAgIC8vIG90aGVyd2lzZSB3YWl0IGZvciB0aGUgc3RyZWFtXG4gICAgc2lnbmFsbGVyLm9uKCdzdHJlYW06YWRkZWQnLCB3YWl0Rm9yU3RyZWFtKTtcbiAgICByZXR1cm4gc2lnbmFsbGVyO1xuICB9O1xuXG4gIC8qKlxuICAgICMjIyMgcHJvZmlsZShkYXRhKVxuXG4gICAgVXBkYXRlIHRoZSBwcm9maWxlIGRhdGEgd2l0aCB0aGUgYXR0YWNoZWQgaW5mb3JtYXRpb24sIHNvIHdoZW5cbiAgICB0aGUgc2lnbmFsbGVyIGFubm91bmNlcyBpdCBpbmNsdWRlcyB0aGlzIGRhdGEgaW4gYWRkaXRpb24gdG8gYW55XG4gICAgcm9vbSBhbmQgaWQgaW5mb3JtYXRpb24uXG5cbiAgKiovXG4gIHNpZ25hbGxlci5wcm9maWxlID0gZnVuY3Rpb24oZGF0YSkge1xuICAgIGV4dGVuZChwcm9maWxlLCBkYXRhIHx8IHt9KTtcblxuICAgIC8vIGlmIHdlIGhhdmUgYWxyZWFkeSBhbm5vdW5jZWQsIHRoZW4gcmVhbm5vdW5jZSBvdXIgcHJvZmlsZSB0byBwcm92aWRlXG4gICAgLy8gb3RoZXJzIGEgYHBlZXI6dXBkYXRlYCBldmVudFxuICAgIGlmIChhbm5vdW5jZWQpIHtcbiAgICAgIGNsZWFyVGltZW91dCh1cGRhdGVUaW1lcik7XG4gICAgICB1cGRhdGVUaW1lciA9IHNldFRpbWVvdXQoZnVuY3Rpb24oKSB7XG4gICAgICAgIC8vIENoZWNrIHRoYXQgb3VyIGFubm91bmNlZCBzdGF0dXMgaGFzbid0IGNoYW5nZWRcbiAgICAgICAgaWYgKCFhbm5vdW5jZWQpIHJldHVybjtcbiAgICAgICAgZGVidWcoJ1snICsgc2lnbmFsbGVyLmlkICsgJ10gcmVhbm5vdW5jaW5nJyk7XG4gICAgICAgIHNpZ25hbGxlci5hbm5vdW5jZShwcm9maWxlKTtcbiAgICAgIH0sIChvcHRzIHx8IHt9KS51cGRhdGVEZWxheSB8fCAxMDAwKTtcbiAgICB9XG5cbiAgICByZXR1cm4gc2lnbmFsbGVyO1xuICB9O1xuXG4gIC8qKlxuICAgICMjIyMgd2FpdEZvckNhbGxcblxuICAgIGBgYFxuICAgIHdhaXRGb3JDYWxsKHRhcmdldElkLCBjYWxsYmFjaylcbiAgICBgYGBcblxuICAgIFdhaXQgZm9yIGEgY2FsbCBmcm9tIHRoZSBzcGVjaWZpZWQgdGFyZ2V0SWQuICBJZiB0aGUgY2FsbCBpcyBhbHJlYWR5XG4gICAgYWN0aXZlIHRoZSBjYWxsYmFjayB3aWxsIGJlIGZpcmVkIGltbWVkaWF0ZWx5LCBvdGhlcndpc2Ugd2Ugd2lsbCB3YWl0XG4gICAgZm9yIGEgYGNhbGw6c3RhcnRlZGAgZXZlbnQgdGhhdCBtYXRjaGVzIHRoZSByZXF1ZXN0ZWQgYHRhcmdldElkYFxuXG4gICoqL1xuICBzaWduYWxsZXIud2FpdEZvckNhbGwgPSBmdW5jdGlvbih0YXJnZXRJZCwgY2FsbGJhY2spIHtcbiAgICB2YXIgY2FsbCA9IGNhbGxzLmdldCh0YXJnZXRJZCk7XG5cbiAgICBpZiAoY2FsbCAmJiBjYWxsLmFjdGl2ZSkge1xuICAgICAgY2FsbGJhY2sobnVsbCwgY2FsbC5wYyk7XG4gICAgICByZXR1cm4gc2lnbmFsbGVyO1xuICAgIH1cblxuICAgIHNpZ25hbGxlci5vbignY2FsbDpzdGFydGVkJywgZnVuY3Rpb24gaGFuZGxlTmV3Q2FsbChpZCkge1xuICAgICAgaWYgKGlkID09PSB0YXJnZXRJZCkge1xuICAgICAgICBzaWduYWxsZXIucmVtb3ZlTGlzdGVuZXIoJ2NhbGw6c3RhcnRlZCcsIGhhbmRsZU5ld0NhbGwpO1xuICAgICAgICBjYWxsYmFjayhudWxsLCBjYWxscy5nZXQoaWQpLnBjKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfTtcblxuICAvKipcbiAgICBBdHRlbXB0cyB0byByZWNvbm5lY3QgdG8gYSBjZXJ0YWluIHRhcmdldCBwZWVyLiBJdCB3aWxsIGNsb3NlIGFueSBleGlzdGluZ1xuICAgIGNhbGwgdG8gdGhhdCBwZWVyLCBhbmQgcmVzdGFydCB0aGUgY29ubmVjdGlvbiBwcm9jZXNzXG4gICAqKi9cbiAgc2lnbmFsbGVyLnJlY29ubmVjdFRvID0gZnVuY3Rpb24oaWQsIHJlY29ubmVjdE9wdHMpIHtcbiAgICBpZiAoIWlkKSByZXR1cm47XG4gICAgc2lnbmFsbGVyLnRvKGlkKS5zZW5kKCcvcmVjb25uZWN0JywgcmVjb25uZWN0T3B0cyk7XG4gICAgLy8gSWYgdGhpcyBpcyB0aGUgbWFzdGVyLCBjb25uZWN0LCBvdGhlcndpc2UgdGhlIG1hc3RlciB3aWxsIHNlbmQgYSAvcmVjb25uZWN0XG4gICAgLy8gbWVzc2FnZSBiYWNrIGluc3RydWN0aW5nIHRoZSBjb25uZWN0aW9uIHRvIHN0YXJ0XG4gICAgdmFyIGlzTWFzdGVyID0gc2lnbmFsbGVyLmlzTWFzdGVyKGlkKTtcbiAgICBpZiAoaXNNYXN0ZXIpIHtcblxuICAgICAgLy8gQWJvcnQgYW55IGN1cnJlbnQgY2FsbHNcbiAgICAgIHNpZ25hbGxlcignbG9nJywgJ2Fib3J0aW5nIGNhbGwnKTtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNhbGxzLmFib3J0KGlkKTtcbiAgICAgIH0gY2F0Y2goZSkge1xuICAgICAgICBzaWduYWxsZXIoJ2xvZycsIGUubWVzc2FnZSk7XG4gICAgICB9XG4gICAgICBzaWduYWxsZXIoJ2xvZycsICdjYWxsIGFib3J0ZWQnKTtcbiAgICAgIHNpZ25hbGxlcigncGVlcjpyZWNvbm5lY3RpbmcnLCBpZCwgcmVjb25uZWN0T3B0cyB8fCB7fSk7XG4gICAgICByZXR1cm4gY29ubmVjdChpZCwgcmVjb25uZWN0T3B0cyk7XG4gICAgfVxuICAgIC8vIEZsYWcgdGhhdCB3ZSBhcmUgd2FpdGluZyBmb3IgdGhlIG1hc3RlciB0byBpbmRpY2F0ZSB0aGUgcmVjb25uZWN0aW9uIGlzIGEgZ29cbiAgICBlbHNlIHtcbiAgICAgIHJlY29ubmVjdGluZ1tpZF0gPSBEYXRlLm5vdygpO1xuICAgIH1cbiAgfTtcblxuICAvLyBpZiB3ZSBoYXZlIGFuIGV4cGVjdGVkIG51bWJlciBvZiBsb2NhbCBzdHJlYW1zLCB0aGVuIHVzZSBhIGZpbHRlciB0b1xuICAvLyBjaGVjayBpZiB3ZSBzaG91bGQgcmVzcG9uZFxuICBpZiAoZXhwZWN0ZWRMb2NhbFN0cmVhbXMpIHtcbiAgICBzaWduYWxsZXIub24oJ3BlZXI6ZmlsdGVyJywgaGFuZGxlUGVlckZpbHRlcik7XG4gIH1cblxuICAvLyByZXNwb25kIHRvIGxvY2FsIGFubm91bmNlIG1lc3NhZ2VzXG4gIHNpZ25hbGxlci5vbignbG9jYWw6YW5ub3VuY2UnLCBoYW5kbGVMb2NhbEFubm91bmNlKTtcblxuICAvLyBoYW5kbGUgcGluZyBtZXNzYWdlc1xuICBzaWduYWxsZXIub24oJ21lc3NhZ2U6cGluZycsIGNhbGxzLnBpbmcpO1xuXG4gIC8vIEhhbmRsZSB3aGVuIGEgcmVtb3RlIHBlZXIgbGVhdmVzIHRoYXQgdGhlIGFwcHJvcHJpYXRlIGNsb3Npbmcgb2NjdXJzIHRoaXNcbiAgLy8gc2lkZSBhcyB3ZWxsXG4gIHNpZ25hbGxlci5vbignbWVzc2FnZTpsZWF2ZScsIGhhbmRsZVBlZXJMZWF2ZSk7XG5cbiAgLy8gV2hlbiBhIGNhbGw6ZW5kZWQsIHdlIHJlYW5ub3VuY2Ugb3Vyc2VsdmVzLiBUaGlzIG9mZmVycyBhIGRlZ3JlZSBvZiBmYWlsdXJlIGhhbmRsaW5nXG4gIC8vIGFzIGlmIGEgY2FsbCBoYXMgZHJvcHBlZCB1bmV4cGVjdGVkbHkgKGllLiBmYWlsdXJlL3VuYWJsZSB0byBjb25uZWN0KSB0aGUgb3RoZXIgcGVlcnNcbiAgLy8gY29ubmVjdGVkIHRvIHRoZSBzaWduYWxsZXIgd2lsbCBhdHRlbXB0IHRvIHJlY29ubmVjdFxuICBzaWduYWxsZXIub24oJ2NhbGw6ZW5kZWQnLCBoYW5kbGVQZWVyQ2xvc2UpO1xuXG4gIC8vIGlmIHdlIHBsdWdpbiBpcyBhY3RpdmUsIHRoZW4gaW5pdGlhbGl6ZSBpdFxuICBpZiAocGx1Z2luKSB7XG4gICAgaW5pdFBsdWdpbigpO1xuICB9IGVsc2Uge1xuICAgIC8vIFRlc3QgaWYgd2UgYXJlIHJlYWR5IHRvIGFubm91bmNlXG4gICAgcHJvY2Vzcy5uZXh0VGljayhmdW5jdGlvbigpIHtcbiAgICAgIGNoZWNrUmVhZHlUb0Fubm91bmNlKCk7XG4gICAgfSk7XG4gIH1cblxuICAvLyBwYXNzIHRoZSBzaWduYWxsZXIgb25cbiAgcmV0dXJuIHNpZ25hbGxlcjtcbn07XG4iLCJ2YXIgcnRjID0gcmVxdWlyZSgncnRjLXRvb2xzJyk7XG52YXIgZGVidWcgPSBydGMubG9nZ2VyKCdydGMtcXVpY2tjb25uZWN0Jyk7XG52YXIgY2xlYW51cCA9IHJlcXVpcmUoJ3J0Yy10b29scy9jbGVhbnVwJyk7XG52YXIgZ2V0YWJsZSA9IHJlcXVpcmUoJ2NvZy9nZXRhYmxlJyk7XG5cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24oc2lnbmFsbGVyLCBvcHRzKSB7XG4gIHZhciBjYWxscyA9IGdldGFibGUoe30pO1xuICB2YXIgZ2V0UGVlckRhdGEgPSByZXF1aXJlKCcuL2dldHBlZXJkYXRhJykoc2lnbmFsbGVyLnBlZXJzKTtcbiAgdmFyIGhlYXJ0YmVhdHMgPSByZXF1aXJlKCcuL2hlYXJ0YmVhdCcpKHNpZ25hbGxlciwgb3B0cyk7XG4gIHZhciBkZWJ1Z1ByZWZpeCA9ICdbJyArIHNpZ25hbGxlci5pZCArICddICc7XG5cbiAgZnVuY3Rpb24gY3JlYXRlKGlkLCBwYywgZGF0YSkge1xuICAgIHZhciBoZWFydGJlYXQgPSBoZWFydGJlYXRzLmNyZWF0ZShpZCk7XG4gICAgdmFyIGNhbGwgPSB7XG4gICAgICBhY3RpdmU6IGZhbHNlLFxuICAgICAgc2lnbmFsbGluZzogZmFsc2UsXG4gICAgICBwYzogcGMsXG4gICAgICBjaGFubmVsczogZ2V0YWJsZSh7fSksXG4gICAgICBzdHJlYW1zOiBbXSxcbiAgICAgIGxhc3RwaW5nOiBEYXRlLm5vdygpLFxuICAgICAgaGVhcnRiZWF0OiBoZWFydGJlYXRcbiAgICB9O1xuICAgIGNhbGxzLnNldChpZCwgY2FsbCk7XG5cbiAgICAvLyBEZXRlY3QgY2hhbmdlcyB0byB0aGUgY29tbXVuaWNhdGlvbiB3aXRoIHRoaXMgcGVlciB2aWFcbiAgICAvLyB0aGUgc2lnbmFsbGVyXG4gICAgaGVhcnRiZWF0Lm9uKCdzaWduYWxsaW5nOnN0YXRlJywgZnVuY3Rpb24oY29ubmVjdGVkKSB7XG4gICAgICBjYWxsLnNpZ25hbGxpbmcgPSBjb25uZWN0ZWQ7XG4gICAgfSk7XG5cbiAgICAvLyBJbmRpY2F0ZSB0aGUgY2FsbCBjcmVhdGlvblxuICAgIGRlYnVnKGRlYnVnUHJlZml4ICsgJ2NhbGwgaGFzIGJlZW4gY3JlYXRlZCBmb3IgJyArIGlkICsgJyAobm90IHlldCBzdGFydGVkKScpO1xuICAgIHNpZ25hbGxlcignY2FsbDpjcmVhdGVkJywgaWQsIHBjLCBkYXRhKTtcbiAgICByZXR1cm4gY2FsbDtcbiAgfVxuXG4gIGZ1bmN0aW9uIGNyZWF0ZVN0cmVhbUFkZEhhbmRsZXIoaWQpIHtcbiAgICByZXR1cm4gZnVuY3Rpb24oZXZ0KSB7XG4gICAgICBkZWJ1ZyhkZWJ1Z1ByZWZpeCArICdwZWVyICcgKyBpZCArICcgYWRkZWQgc3RyZWFtJyk7XG4gICAgICB1cGRhdGVSZW1vdGVTdHJlYW1zKGlkKTtcbiAgICAgIHJlY2VpdmVSZW1vdGVTdHJlYW0oaWQpKGV2dC5zdHJlYW0pO1xuICAgIH07XG4gIH1cblxuICBmdW5jdGlvbiBjcmVhdGVTdHJlYW1SZW1vdmVIYW5kbGVyKGlkKSB7XG4gICAgcmV0dXJuIGZ1bmN0aW9uKGV2dCkge1xuICAgICAgZGVidWcoZGVidWdQcmVmaXggKyAncGVlciAnICsgaWQgKyAnIHJlbW92ZWQgc3RyZWFtJyk7XG4gICAgICB1cGRhdGVSZW1vdGVTdHJlYW1zKGlkKTtcbiAgICAgIHNpZ25hbGxlcignc3RyZWFtOnJlbW92ZWQnLCBpZCwgZXZ0LnN0cmVhbSk7XG4gICAgfTtcbiAgfVxuXG4gIC8qKlxuICAgIEZhaWxpbmcgaXMgaW52b2tlZCB3aGVuIGEgY2FsbCBpbiB0aGUgcHJvY2VzcyBvZiBmYWlsaW5nLCB1c3VhbGx5IGFzIGEgcmVzdWx0XG4gICAgb2YgYSBkaXNjb25uZWN0aW9uIGluIHRoZSBQZWVyQ29ubmVjdGlvbi4gQSBjb25uZWN0aW9uIHRoYXQgaXMgZmFpbGluZyBjYW5cbiAgICBiZSByZWNvdmVyZWQsIGhvd2V2ZXIsIGVuY291bnRlcmluZyB0aGlzIHN0YXRlIGRvZXMgaW5kaWNhdGUgdGhlIGNhbGwgaXMgaW4gdHJvdWJsZVxuICAgKiovXG4gIGZ1bmN0aW9uIGZhaWxpbmcoaWQpIHtcbiAgICB2YXIgY2FsbCA9IGNhbGxzLmdldChpZCk7XG4gICAgLy8gSWYgbm8gY2FsbCBleGlzdHMsIGRvIG5vdGhpbmdcbiAgICBpZiAoIWNhbGwpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBkZWJ1ZyhkZWJ1Z1ByZWZpeCArICdjYWxsIGlzIGZhaWxpbmcgZm9yICcgKyBpZCk7XG4gICAgc2lnbmFsbGVyKCdjYWxsOmZhaWxpbmcnLCBpZCwgY2FsbCAmJiBjYWxsLnBjKTtcbiAgfVxuXG4gIC8qKlxuICAgIFJlY292ZXJlZCBpcyBpbnZva2VkIHdoZW4gYSBjYWxsIHdoaWNoIHdhcyBwcmV2aW91c2x5IGZhaWxpbmcgaGFzIHJlY292ZXJlZC4gTmFtZWx5LFxuICAgIHRoZSBQZWVyQ29ubmVjdGlvbiBoYXMgYmVlbiByZXN0b3JlZCBieSBjb25uZWN0aXZpdHkgYmVpbmcgcmVlc3RhYmxpc2hlZCAocHJpbWFyeSBjYXVzZVxuICAgIHdvdWxkIHByb2JhYmx5IGJlIG5ldHdvcmsgY29ubmVjdGlvbiBkcm9wIG91dHMsIHN1Y2ggYXMgV2lGaSlcbiAgICoqL1xuICBmdW5jdGlvbiByZWNvdmVyZWQoaWQpIHtcbiAgICB2YXIgY2FsbCA9IGNhbGxzLmdldChpZCk7XG4gICAgLy8gSWYgbm8gY2FsbCBleGlzdHMsIGRvIG5vdGhpbmdcbiAgICBpZiAoIWNhbGwpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBkZWJ1ZyhkZWJ1Z1ByZWZpeCArICdjYWxsIGhhcyByZWNvdmVyZWQgZm9yICcgKyBpZCk7XG4gICAgc2lnbmFsbGVyKCdjYWxsOnJlY292ZXJlZCcsIGlkLCBjYWxsICYmIGNhbGwucGMpO1xuICB9XG5cbiAgZnVuY3Rpb24gZmFpbChpZCkge1xuICAgIHZhciBjYWxsID0gY2FsbHMuZ2V0KGlkKTtcbiAgICAvLyBJZiBubyBjYWxsIGV4aXN0cywgZG8gbm90aGluZ1xuICAgIGlmICghY2FsbCkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGRlYnVnKGRlYnVnUHJlZml4ICsgJ2NhbGwgaGFzIGZhaWxlZCBmb3IgJyArIGlkKTtcbiAgICBzaWduYWxsZXIoJ2NhbGw6ZmFpbGVkJywgaWQsIGNhbGwgJiYgY2FsbC5wYyk7XG4gICAgZW5kKGlkKTtcbiAgfVxuXG4gIC8qKlxuICAgIFN0b3BzIHRoZSBjb3VwbGluZyBwcm9jZXNzIGZvciBhIGNhbGxcbiAgICoqL1xuICBmdW5jdGlvbiBhYm9ydChpZCkge1xuICAgIHZhciBjYWxsID0gY2FsbHMuZ2V0KGlkKTtcbiAgICAvLyBJZiBubyBjYWxsLCBkbyBub3RoaW5nXG4gICAgaWYgKCFjYWxsKSByZXR1cm47XG5cbiAgICBpZiAoY2FsbC5tb25pdG9yKSBjYWxsLm1vbml0b3IuYWJvcnQoKTtcbiAgICBzaWduYWxsZXIoJ2NhbGw6YWJvcnRlZCcsIGlkLCBjYWxsICYmIGNhbGwucGMpO1xuICAgIGVuZChpZCk7XG4gIH1cblxuICBmdW5jdGlvbiBlbmQoaWQpIHtcbiAgICB2YXIgY2FsbCA9IGNhbGxzLmdldChpZCk7XG5cbiAgICAvLyBpZiB3ZSBoYXZlIG5vIGRhdGEsIHRoZW4gZG8gbm90aGluZ1xuICAgIGlmICghIGNhbGwpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBTdG9wIHRoZSBoZWFydGJlYXRcbiAgICBpZiAoY2FsbC5oZWFydGJlYXQpIHtcbiAgICAgIGNhbGwuaGVhcnRiZWF0LnN0b3AoKTtcbiAgICB9XG5cbiAgICAvLyBJZiBhIG1vbml0b3IgaXMgYXR0YWNoZWQsIHJlbW92ZSBhbGwgbGlzdGVuZXJzXG4gICAgaWYgKGNhbGwubW9uaXRvcikge1xuICAgICAgY2FsbC5tb25pdG9yLnN0b3AoKTtcbiAgICB9XG5cbiAgICAvLyBpZiB3ZSBoYXZlIG5vIGRhdGEsIHRoZW4gcmV0dXJuXG4gICAgY2FsbC5jaGFubmVscy5rZXlzKCkuZm9yRWFjaChmdW5jdGlvbihsYWJlbCkge1xuICAgICAgdmFyIGNoYW5uZWwgPSBjYWxsLmNoYW5uZWxzLmdldChsYWJlbCk7XG4gICAgICB2YXIgYXJncyA9IFtpZCwgY2hhbm5lbCwgbGFiZWxdO1xuXG4gICAgICAvLyBlbWl0IHRoZSBwbGFpbiBjaGFubmVsOmNsb3NlZCBldmVudFxuICAgICAgc2lnbmFsbGVyLmFwcGx5KHNpZ25hbGxlciwgWydjaGFubmVsOmNsb3NlZCddLmNvbmNhdChhcmdzKSk7XG5cbiAgICAgIC8vIGVtaXQgdGhlIGxhYmVsbGVkIHZlcnNpb24gb2YgdGhlIGV2ZW50XG4gICAgICBzaWduYWxsZXIuYXBwbHkoc2lnbmFsbGVyLCBbJ2NoYW5uZWw6Y2xvc2VkOicgKyBsYWJlbF0uY29uY2F0KGFyZ3MpKTtcblxuICAgICAgLy8gZGVjb3VwbGUgdGhlIGV2ZW50c1xuICAgICAgY2hhbm5lbC5vbm9wZW4gPSBudWxsO1xuICAgIH0pO1xuXG4gICAgLy8gdHJpZ2dlciBzdHJlYW06cmVtb3ZlZCBldmVudHMgZm9yIGVhY2ggb2YgdGhlIHJlbW90ZXN0cmVhbXMgaW4gdGhlIHBjXG4gICAgY2FsbC5zdHJlYW1zLmZvckVhY2goZnVuY3Rpb24oc3RyZWFtKSB7XG4gICAgICBzaWduYWxsZXIoJ3N0cmVhbTpyZW1vdmVkJywgaWQsIHN0cmVhbSk7XG4gICAgfSk7XG5cbiAgICAvLyBkZWxldGUgdGhlIGNhbGwgZGF0YVxuICAgIGNhbGxzLmRlbGV0ZShpZCk7XG5cbiAgICAvLyB0cmlnZ2VyIHRoZSBjYWxsOmVuZGVkIGV2ZW50XG4gICAgZGVidWcoZGVidWdQcmVmaXggKyAnY2FsbCBoYXMgZW5kZWQgZm9yICcgKyBpZCk7XG4gICAgc2lnbmFsbGVyKCdjYWxsOmVuZGVkJywgaWQsIGNhbGwucGMpO1xuICAgIHNpZ25hbGxlcignY2FsbDonICsgaWQgKyAnOmVuZGVkJywgY2FsbC5wYyk7XG5cbiAgICAvLyBlbnN1cmUgdGhlIHBlZXIgY29ubmVjdGlvbiBpcyBwcm9wZXJseSBjbGVhbmVkIHVwXG4gICAgY2xlYW51cChjYWxsLnBjKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIHBpbmcoc2VuZGVyKSB7XG4gICAgdmFyIGNhbGwgPSBjYWxscy5nZXQoc2VuZGVyICYmIHNlbmRlci5pZCk7XG5cbiAgICAvLyBzZXQgdGhlIGxhc3QgcGluZyBmb3IgdGhlIGRhdGFcbiAgICBpZiAoY2FsbCkge1xuICAgICAgY2FsbC5sYXN0cGluZyA9IERhdGUubm93KCk7XG4gICAgICBjYWxsLmhlYXJ0YmVhdC50b3VjaCgpO1xuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIHJlY2VpdmVSZW1vdGVTdHJlYW0oaWQpIHtcbiAgICByZXR1cm4gZnVuY3Rpb24oc3RyZWFtKSB7XG4gICAgICBzaWduYWxsZXIoJ3N0cmVhbTphZGRlZCcsIGlkLCBzdHJlYW0sIGdldFBlZXJEYXRhKGlkKSk7XG4gICAgfTtcbiAgfVxuXG4gIGZ1bmN0aW9uIHN0YXJ0KGlkLCBwYywgZGF0YSkge1xuICAgIHZhciBjYWxsID0gY2FsbHMuZ2V0KGlkKTtcbiAgICB2YXIgc3RyZWFtcyA9IFtdLmNvbmNhdChwYy5nZXRSZW1vdGVTdHJlYW1zKCkpO1xuXG4gICAgLy8gZmxhZyB0aGUgY2FsbCBhcyBhY3RpdmVcbiAgICBjYWxsLmFjdGl2ZSA9IHRydWU7XG4gICAgY2FsbC5zdHJlYW1zID0gW10uY29uY2F0KHBjLmdldFJlbW90ZVN0cmVhbXMoKSk7XG5cbiAgICBwYy5vbmFkZHN0cmVhbSA9IGNyZWF0ZVN0cmVhbUFkZEhhbmRsZXIoaWQpO1xuICAgIHBjLm9ucmVtb3Zlc3RyZWFtID0gY3JlYXRlU3RyZWFtUmVtb3ZlSGFuZGxlcihpZCk7XG5cbiAgICBkZWJ1ZyhkZWJ1Z1ByZWZpeCArICcgLT4gJyArIGlkICsgJyBjYWxsIHN0YXJ0OiAnICsgc3RyZWFtcy5sZW5ndGggKyAnIHN0cmVhbXMnKTtcbiAgICBzaWduYWxsZXIoJ2NhbGw6c3RhcnRlZCcsIGlkLCBwYywgZGF0YSk7XG5cbiAgICAvLyBjb25maWd1cmUgdGhlIGhlYXJ0YmVhdCB0aW1lclxuICAgIGNhbGwubGFzdHBpbmcgPSBEYXRlLm5vdygpO1xuXG4gICAgLy8gTW9uaXRvciB0aGUgaGVhcnRiZWF0IGZvciBzaWduYWxsZXIgZGlzY29ubmVjdGlvblxuICAgIGNhbGwuaGVhcnRiZWF0Lm9uY2UoJ2Rpc2Nvbm5lY3RlZCcsIGZ1bmN0aW9uKCkge1xuICAgICAgc2lnbmFsbGVyKCdjYWxsOmV4cGlyZWQnLCBpZCwgY2FsbC5wYyk7XG4gICAgICByZXR1cm4gZW5kKGlkKTtcbiAgICB9KTtcblxuICAgIC8vIGV4YW1pbmUgdGhlIGV4aXN0aW5nIHJlbW90ZSBzdHJlYW1zIGFmdGVyIGEgc2hvcnQgZGVsYXlcbiAgICBwcm9jZXNzLm5leHRUaWNrKGZ1bmN0aW9uKCkge1xuICAgICAgLy8gaXRlcmF0ZSB0aHJvdWdoIGFueSByZW1vdGUgc3RyZWFtc1xuICAgICAgc3RyZWFtcy5mb3JFYWNoKHJlY2VpdmVSZW1vdGVTdHJlYW0oaWQpKTtcbiAgICB9KTtcbiAgfVxuXG4gIGZ1bmN0aW9uIHVwZGF0ZVJlbW90ZVN0cmVhbXMoaWQpIHtcbiAgICB2YXIgY2FsbCA9IGNhbGxzLmdldChpZCk7XG5cbiAgICBpZiAoY2FsbCAmJiBjYWxsLnBjKSB7XG4gICAgICBjYWxsLnN0cmVhbXMgPSBbXS5jb25jYXQoY2FsbC5wYy5nZXRSZW1vdGVTdHJlYW1zKCkpO1xuICAgIH1cbiAgfVxuXG4gIGNhbGxzLmFib3J0ID0gYWJvcnQ7XG4gIGNhbGxzLmNyZWF0ZSA9IGNyZWF0ZTtcbiAgY2FsbHMuZW5kID0gZW5kO1xuICBjYWxscy5mYWlsID0gZmFpbDtcbiAgY2FsbHMuZmFpbGluZyA9IGZhaWxpbmc7XG4gIGNhbGxzLnBpbmcgPSBwaW5nO1xuICBjYWxscy5zdGFydCA9IHN0YXJ0O1xuICBjYWxscy5yZWNvdmVyZWQgPSByZWNvdmVyZWQ7XG5cbiAgcmV0dXJuIGNhbGxzO1xufTtcbiIsIm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24ocGVlcnMpIHtcbiAgcmV0dXJuIGZ1bmN0aW9uKGlkKSB7XG4gICAgdmFyIHBlZXIgPSBwZWVycy5nZXQoaWQpO1xuICAgIHJldHVybiBwZWVyICYmIHBlZXIuZGF0YTtcbiAgfTtcbn07XG4iLCJ2YXIgbWJ1cyA9IHJlcXVpcmUoJ21idXMnKTtcblxubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihzaWduYWxsZXIsIG9wdHMpIHtcblxuICBvcHRzID0gb3B0cyB8fCB7fTtcblxuICAvKipcbiAgICBDcmVhdGVzIGEgbmV3IGhlYXJ0YmVhdFxuICAgKiovXG4gIGZ1bmN0aW9uIGNyZWF0ZShpZCkge1xuXG4gICAgdmFyIGhlYXJ0YmVhdCA9IG1idXMoKTtcbiAgICB2YXIgZGVsYXkgPSAodHlwZW9mIG9wdHMuaGVhcnRiZWF0ID09PSAnbnVtYmVyJyA/IG9wdHMuaGVhcnRiZWF0IDogMjUwMCk7XG4gICAgdmFyIGlnbm9yZURpc2Nvbm5lY3Rpb24gPSAob3B0cyB8fCB7fSkuaWdub3JlRGlzY29ubmVjdGlvbiB8fCBmYWxzZTsgLy9pZiB5b3Ugd2FudCB0byByZWx5IG9uIHlvdXIgc3dpdGNoYm9hcmQgdG8gdGVsbCBpZiB0aGUgY2FsbCBpcyBzdGlsbCBnb2luZ1xuICAgIHZhciB0aW1lciA9IG51bGw7XG4gICAgdmFyIGNvbm5lY3RlZCA9IGZhbHNlO1xuICAgIHZhciBsYXN0cGluZyA9IDA7XG5cbiAgICAvKipcbiAgICAgIFBpbmdzIHRoZSB0YXJnZXQgcGVlclxuICAgICAqKi9cbiAgICBmdW5jdGlvbiBwaW5nKCkge1xuICAgICAgc2lnbmFsbGVyLnRvKGlkKS5zZW5kKCcvcGluZycpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAgQ2hlY2tzIHRoZSBzdGF0ZSBvZiB0aGUgc2lnbmFsbGVyIGNvbm5lY3Rpb25cbiAgICAgKiovXG4gICAgZnVuY3Rpb24gY2hlY2soKSB7XG4gICAgICB2YXIgdGlja0luYWN0aXZlID0gKERhdGUubm93KCkgLSAoZGVsYXkgKiA0KSk7IC8vZG9lc250IGFsd2F5cyB3b3JrXG5cbiAgICAgIHZhciBjdXJyZW50bHlDb25uZWN0ZWQgPSBpZ25vcmVEaXNjb25uZWN0aW9uID8gaWdub3JlRGlzY29ubmVjdGlvbiA6IChsYXN0cGluZyA+PSB0aWNrSW5hY3RpdmUpO1xuICAgICAgLy8gSWYgd2UgaGF2ZSBjaGFuZ2VkIGNvbm5lY3Rpb24gc3RhdGUsIGZsYWcgdGhlIGNoYW5nZVxuICAgICAgaWYgKGNvbm5lY3RlZCAhPT0gY3VycmVudGx5Q29ubmVjdGVkKSB7XG4gICAgICAgIGhlYXJ0YmVhdChjdXJyZW50bHlDb25uZWN0ZWQgPyAnY29ubmVjdGVkJyA6ICdkaXNjb25uZWN0ZWQnKTtcbiAgICAgICAgaGVhcnRiZWF0KCdzaWduYWxsaW5nOnN0YXRlJywgY3VycmVudGx5Q29ubmVjdGVkKTtcbiAgICAgICAgY29ubmVjdGVkID0gY3VycmVudGx5Q29ubmVjdGVkO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAgQ2hlY2tzIHRoZSBzdGF0ZSBvZiB0aGUgY29ubmVjdGlvbiwgYW5kIHBpbmdzIGFzIHdlbGxcbiAgICAgKiovXG4gICAgZnVuY3Rpb24gYmVhdCgpIHtcbiAgICAgIGNoZWNrKCk7XG4gICAgICBwaW5nKCk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICBTdGFydHMgdGhlIGhlYXJ0YmVhdFxuICAgICAqKi9cbiAgICBoZWFydGJlYXQuc3RhcnQgPSBmdW5jdGlvbigpIHtcbiAgICAgIGlmICh0aW1lcikgaGVhcnRiZWF0LnN0b3AoKTtcbiAgICAgIGlmIChkZWxheSA8PSAwKSByZXR1cm47XG5cbiAgICAgIHRpbWVyID0gc2V0SW50ZXJ2YWwoYmVhdCwgZGVsYXkpO1xuICAgICAgYmVhdCgpO1xuICAgIH07XG5cbiAgICAvKipcbiAgICAgIFN0b3BzIHRoZSBoZWFydGJlYXRcbiAgICAgKiovXG4gICAgaGVhcnRiZWF0LnN0b3AgPSBmdW5jdGlvbigpIHtcbiAgICAgIGlmICghdGltZXIpIHJldHVybjtcbiAgICAgIGNsZWFySW50ZXJ2YWwodGltZXIpO1xuICAgICAgdGltZXIgPSBudWxsO1xuICAgIH07XG5cbiAgICAvKipcbiAgICAgIFJlZ2lzdGVycyB0aGUgcmVjZWlwdCBvbiBhIHBpbmdcbiAgICAgKiovXG4gICAgaGVhcnRiZWF0LnRvdWNoID0gZnVuY3Rpb24oKSB7XG4gICAgICBsYXN0cGluZyA9IERhdGUubm93KCk7XG4gICAgICBjaGVjaygpO1xuICAgIH07XG5cbiAgICAvKipcbiAgICAgIFVwZGF0ZXMgdGhlIGRlbGF5IGludGVydmFsXG4gICAgICoqL1xuICAgIGhlYXJ0YmVhdC51cGRhdGVEZWxheSA9IGZ1bmN0aW9uKHZhbHVlKSB7XG4gICAgICBkZWxheSA9IHZhbHVlO1xuICAgICAgaGVhcnRiZWF0LnN0YXJ0KCk7XG4gICAgfTtcblxuICAgIGhlYXJ0YmVhdC5zdGFydCgpO1xuICAgIHJldHVybiBoZWFydGJlYXQ7XG4gIH1cblxuICByZXR1cm4ge1xuICAgIGNyZWF0ZTogY3JlYXRlXG4gIH07XG59O1xuIiwidmFyIHJ0YyA9IHJlcXVpcmUoJ3J0Yy10b29scycpO1xudmFyIGRlYnVnID0gcnRjLmxvZ2dlcigncnRjLXF1aWNrY29ubmVjdCcpO1xuXG4vKipcbiAgU2NoZW1lcyBhbGxvdyBtdWx0aXBsZSBjb25uZWN0aW9uIHNjaGVtZXMgZm9yIHNlbGVjdGlvbiB3aGVuIGF0dGVtcHRpbmcgdG8gY29ubmVjdCB0b1xuICBhIHBlZXJcbiAqKi9cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24oc2lnbmFsbGVyLCBvcHRzKSB7XG5cbiAgdmFyIHNjaGVtZXMgPSB7fTtcbiAgdmFyIF9kZWZhdWx0O1xuXG4gIC8qKlxuICAgIEFkZHMgYSBjb25uZWN0aW9uIHNjaGVtZVxuICAgKiovXG4gIGZ1bmN0aW9uIGFkZChzY2hlbWUpIHtcbiAgICAvLyBFbnN1cmUgdmFsaWQgSURcbiAgICBpZiAoIXNjaGVtZSB8fCAhc2NoZW1lLmlkIHx8IHR5cGVvZiBzY2hlbWUuaWQgIT09ICdzdHJpbmcnKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ0Nhbm5vdCBhZGQgaW52YWxpZCBzY2hlbWUuIFJlcXVpcmVzIGF0IGxlYXN0IGFuIElEJyk7XG4gICAgfVxuICAgIC8vIFVuaXF1ZSBzY2hlbWVzXG4gICAgaWYgKHNjaGVtZXNbc2NoZW1lLmlkXSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdTY2hlbWUgJyArIHNjaGVtZUlkICsgJyBhbHJlYWR5IGV4aXN0cycpO1xuICAgIH1cbiAgICAvLyBDaGVjayBkZWZhdWx0XG4gICAgaWYgKHNjaGVtZS5pc0RlZmF1bHQpIHtcbiAgICAgIGlmIChfZGVmYXVsdCkge1xuICAgICAgICBjb25zb2xlLndhcm4oJ0RlZmF1bHQgc2NoZW1lIGFscmVhZHkgZXhpc3RzJyk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBfZGVmYXVsdCA9IHNjaGVtZS5pZDtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBzY2hlbWVzW3NjaGVtZS5pZF0gPSBzY2hlbWU7XG4gIH1cblxuICAvKipcbiAgICBSZXR1cm5zIHRoZSBzY2hlbWUgd2l0aCB0aGUgZ2l2ZW4gSUQuIElmIGNhbkRlZmF1bHQgaXMgdHJ1ZSBpdCB3aWxsIHJldHVybiB0aGUgZGVmYXVsdCBzY2hlbWVcbiAgICBpZiBubyBzY2hlbWUgd2l0aCBJRCBpcyBmb3VuZFxuICAgKiovXG4gIGZ1bmN0aW9uIGdldChpZCwgY2FuRGVmYXVsdCkge1xuICAgIHJldHVybiBzY2hlbWVzW2lkXSB8fCAoY2FuRGVmYXVsdCAmJiBfZGVmYXVsdCA/IHNjaGVtZXNbX2RlZmF1bHRdIDogdW5kZWZpbmVkKTtcbiAgfVxuXG4gIC8vIExvYWQgcGFzc2VkIGluIHNjaGVtZXNcbiAgaWYgKG9wdHMgJiYgb3B0cy5zY2hlbWVzICYmIEFycmF5LmlzQXJyYXkob3B0cy5zY2hlbWVzKSkge1xuICAgIG9wdHMuc2NoZW1lcy5mb3JFYWNoKGFkZCk7XG4gIH1cblxuICByZXR1cm4ge1xuICAgIGFkZDogYWRkLFxuICAgIGdldDogZ2V0XG4gIH07XG59OyIsIi8qIGpzaGludCBub2RlOiB0cnVlICovXG4ndXNlIHN0cmljdCc7XG5cbi8qKlxuIyMgY29nL2RlZmF1bHRzXG5cbmBgYGpzXG52YXIgZGVmYXVsdHMgPSByZXF1aXJlKCdjb2cvZGVmYXVsdHMnKTtcbmBgYFxuXG4jIyMgZGVmYXVsdHModGFyZ2V0LCAqKVxuXG5TaGFsbG93IGNvcHkgb2JqZWN0IHByb3BlcnRpZXMgZnJvbSB0aGUgc3VwcGxpZWQgc291cmNlIG9iamVjdHMgKCopIGludG9cbnRoZSB0YXJnZXQgb2JqZWN0LCByZXR1cm5pbmcgdGhlIHRhcmdldCBvYmplY3Qgb25jZSBjb21wbGV0ZWQuICBEbyBub3QsXG5ob3dldmVyLCBvdmVyd3JpdGUgZXhpc3Rpbmcga2V5cyB3aXRoIG5ldyB2YWx1ZXM6XG5cbmBgYGpzXG5kZWZhdWx0cyh7IGE6IDEsIGI6IDIgfSwgeyBjOiAzIH0sIHsgZDogNCB9LCB7IGI6IDUgfSkpO1xuYGBgXG5cblNlZSBhbiBleGFtcGxlIG9uIFtyZXF1aXJlYmluXShodHRwOi8vcmVxdWlyZWJpbi5jb20vP2dpc3Q9NjA3OTQ3NSkuXG4qKi9cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24odGFyZ2V0KSB7XG4gIC8vIGVuc3VyZSB3ZSBoYXZlIGEgdGFyZ2V0XG4gIHRhcmdldCA9IHRhcmdldCB8fCB7fTtcblxuICAvLyBpdGVyYXRlIHRocm91Z2ggdGhlIHNvdXJjZXMgYW5kIGNvcHkgdG8gdGhlIHRhcmdldFxuICBbXS5zbGljZS5jYWxsKGFyZ3VtZW50cywgMSkuZm9yRWFjaChmdW5jdGlvbihzb3VyY2UpIHtcbiAgICBpZiAoISBzb3VyY2UpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBmb3IgKHZhciBwcm9wIGluIHNvdXJjZSkge1xuICAgICAgaWYgKHRhcmdldFtwcm9wXSA9PT0gdm9pZCAwKSB7XG4gICAgICAgIHRhcmdldFtwcm9wXSA9IHNvdXJjZVtwcm9wXTtcbiAgICAgIH1cbiAgICB9XG4gIH0pO1xuXG4gIHJldHVybiB0YXJnZXQ7XG59OyIsIi8qIGpzaGludCBub2RlOiB0cnVlICovXG4ndXNlIHN0cmljdCc7XG5cbi8qKlxuIyMgY29nL2V4dGVuZFxuXG5gYGBqc1xudmFyIGV4dGVuZCA9IHJlcXVpcmUoJ2NvZy9leHRlbmQnKTtcbmBgYFxuXG4jIyMgZXh0ZW5kKHRhcmdldCwgKilcblxuU2hhbGxvdyBjb3B5IG9iamVjdCBwcm9wZXJ0aWVzIGZyb20gdGhlIHN1cHBsaWVkIHNvdXJjZSBvYmplY3RzICgqKSBpbnRvXG50aGUgdGFyZ2V0IG9iamVjdCwgcmV0dXJuaW5nIHRoZSB0YXJnZXQgb2JqZWN0IG9uY2UgY29tcGxldGVkOlxuXG5gYGBqc1xuZXh0ZW5kKHsgYTogMSwgYjogMiB9LCB7IGM6IDMgfSwgeyBkOiA0IH0sIHsgYjogNSB9KSk7XG5gYGBcblxuU2VlIGFuIGV4YW1wbGUgb24gW3JlcXVpcmViaW5dKGh0dHA6Ly9yZXF1aXJlYmluLmNvbS8/Z2lzdD02MDc5NDc1KS5cbioqL1xubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbih0YXJnZXQpIHtcbiAgW10uc2xpY2UuY2FsbChhcmd1bWVudHMsIDEpLmZvckVhY2goZnVuY3Rpb24oc291cmNlKSB7XG4gICAgaWYgKCEgc291cmNlKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgZm9yICh2YXIgcHJvcCBpbiBzb3VyY2UpIHtcbiAgICAgIHRhcmdldFtwcm9wXSA9IHNvdXJjZVtwcm9wXTtcbiAgICB9XG4gIH0pO1xuXG4gIHJldHVybiB0YXJnZXQ7XG59OyIsIi8qKlxuICAjIyBjb2cvZ2V0YWJsZVxuXG4gIFRha2UgYW4gb2JqZWN0IGFuZCBwcm92aWRlIGEgd3JhcHBlciB0aGF0IGFsbG93cyB5b3UgdG8gYGdldGAgYW5kXG4gIGBzZXRgIHZhbHVlcyBvbiB0aGF0IG9iamVjdC5cblxuKiovXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKHRhcmdldCkge1xuICBmdW5jdGlvbiBnZXQoa2V5KSB7XG4gICAgcmV0dXJuIHRhcmdldFtrZXldO1xuICB9XG5cbiAgZnVuY3Rpb24gc2V0KGtleSwgdmFsdWUpIHtcbiAgICB0YXJnZXRba2V5XSA9IHZhbHVlO1xuICB9XG5cbiAgZnVuY3Rpb24gcmVtb3ZlKGtleSkge1xuICAgIHJldHVybiBkZWxldGUgdGFyZ2V0W2tleV07XG4gIH1cblxuICBmdW5jdGlvbiBrZXlzKCkge1xuICAgIHJldHVybiBPYmplY3Qua2V5cyh0YXJnZXQpO1xuICB9O1xuXG4gIGZ1bmN0aW9uIHZhbHVlcygpIHtcbiAgICByZXR1cm4gT2JqZWN0LmtleXModGFyZ2V0KS5tYXAoZnVuY3Rpb24oa2V5KSB7XG4gICAgICByZXR1cm4gdGFyZ2V0W2tleV07XG4gICAgfSk7XG4gIH07XG5cbiAgaWYgKHR5cGVvZiB0YXJnZXQgIT0gJ29iamVjdCcpIHtcbiAgICByZXR1cm4gdGFyZ2V0O1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBnZXQ6IGdldCxcbiAgICBzZXQ6IHNldCxcbiAgICByZW1vdmU6IHJlbW92ZSxcbiAgICBkZWxldGU6IHJlbW92ZSxcbiAgICBrZXlzOiBrZXlzLFxuICAgIHZhbHVlczogdmFsdWVzXG4gIH07XG59O1xuIiwiLyoganNoaW50IG5vZGU6IHRydWUgKi9cbid1c2Ugc3RyaWN0JztcblxuLyoqXG4gICMjIGNvZy9sb2dnZXJcblxuICBgYGBqc1xuICB2YXIgbG9nZ2VyID0gcmVxdWlyZSgnY29nL2xvZ2dlcicpO1xuICBgYGBcblxuICBTaW1wbGUgYnJvd3NlciBsb2dnaW5nIG9mZmVyaW5nIHNpbWlsYXIgZnVuY3Rpb25hbGl0eSB0byB0aGVcbiAgW2RlYnVnXShodHRwczovL2dpdGh1Yi5jb20vdmlzaW9ubWVkaWEvZGVidWcpIG1vZHVsZS5cblxuICAjIyMgVXNhZ2VcblxuICBDcmVhdGUgeW91ciBzZWxmIGEgbmV3IGxvZ2dpbmcgaW5zdGFuY2UgYW5kIGdpdmUgaXQgYSBuYW1lOlxuXG4gIGBgYGpzXG4gIHZhciBkZWJ1ZyA9IGxvZ2dlcigncGhpbCcpO1xuICBgYGBcblxuICBOb3cgZG8gc29tZSBkZWJ1Z2dpbmc6XG5cbiAgYGBganNcbiAgZGVidWcoJ2hlbGxvJyk7XG4gIGBgYFxuXG4gIEF0IHRoaXMgc3RhZ2UsIG5vIGxvZyBvdXRwdXQgd2lsbCBiZSBnZW5lcmF0ZWQgYmVjYXVzZSB5b3VyIGxvZ2dlciBpc1xuICBjdXJyZW50bHkgZGlzYWJsZWQuICBFbmFibGUgaXQ6XG5cbiAgYGBganNcbiAgbG9nZ2VyLmVuYWJsZSgncGhpbCcpO1xuICBgYGBcblxuICBOb3cgZG8gc29tZSBtb3JlIGxvZ2dlcjpcblxuICBgYGBqc1xuICBkZWJ1ZygnT2ggdGhpcyBpcyBzbyBtdWNoIG5pY2VyIDopJyk7XG4gIC8vIC0tPiBwaGlsOiBPaCB0aGlzIGlzIHNvbWUgbXVjaCBuaWNlciA6KVxuICBgYGBcblxuICAjIyMgUmVmZXJlbmNlXG4qKi9cblxudmFyIGFjdGl2ZSA9IFtdO1xudmFyIHVubGVhc2hMaXN0ZW5lcnMgPSBbXTtcbnZhciB0YXJnZXRzID0gWyBjb25zb2xlIF07XG5cbi8qKlxuICAjIyMjIGxvZ2dlcihuYW1lKVxuXG4gIENyZWF0ZSBhIG5ldyBsb2dnaW5nIGluc3RhbmNlLlxuKiovXG52YXIgbG9nZ2VyID0gbW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihuYW1lKSB7XG4gIC8vIGluaXRpYWwgZW5hYmxlZCBjaGVja1xuICB2YXIgZW5hYmxlZCA9IGNoZWNrQWN0aXZlKCk7XG5cbiAgZnVuY3Rpb24gY2hlY2tBY3RpdmUoKSB7XG4gICAgcmV0dXJuIGVuYWJsZWQgPSBhY3RpdmUuaW5kZXhPZignKicpID49IDAgfHwgYWN0aXZlLmluZGV4T2YobmFtZSkgPj0gMDtcbiAgfVxuXG4gIC8vIHJlZ2lzdGVyIHRoZSBjaGVjayBhY3RpdmUgd2l0aCB0aGUgbGlzdGVuZXJzIGFycmF5XG4gIHVubGVhc2hMaXN0ZW5lcnNbdW5sZWFzaExpc3RlbmVycy5sZW5ndGhdID0gY2hlY2tBY3RpdmU7XG5cbiAgLy8gcmV0dXJuIHRoZSBhY3R1YWwgbG9nZ2luZyBmdW5jdGlvblxuICByZXR1cm4gZnVuY3Rpb24oKSB7XG4gICAgdmFyIGFyZ3MgPSBbXS5zbGljZS5jYWxsKGFyZ3VtZW50cyk7XG5cbiAgICAvLyBpZiB3ZSBoYXZlIGEgc3RyaW5nIG1lc3NhZ2VcbiAgICBpZiAodHlwZW9mIGFyZ3NbMF0gPT0gJ3N0cmluZycgfHwgKGFyZ3NbMF0gaW5zdGFuY2VvZiBTdHJpbmcpKSB7XG4gICAgICBhcmdzWzBdID0gbmFtZSArICc6ICcgKyBhcmdzWzBdO1xuICAgIH1cblxuICAgIC8vIGlmIG5vdCBlbmFibGVkLCBiYWlsXG4gICAgaWYgKCEgZW5hYmxlZCkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIGxvZ1xuICAgIHRhcmdldHMuZm9yRWFjaChmdW5jdGlvbih0YXJnZXQpIHtcbiAgICAgIHRhcmdldC5sb2cuYXBwbHkodGFyZ2V0LCBhcmdzKTtcbiAgICB9KTtcbiAgfTtcbn07XG5cbi8qKlxuICAjIyMjIGxvZ2dlci5yZXNldCgpXG5cbiAgUmVzZXQgbG9nZ2luZyAocmVtb3ZlIHRoZSBkZWZhdWx0IGNvbnNvbGUgbG9nZ2VyLCBmbGFnIGFsbCBsb2dnZXJzIGFzXG4gIGluYWN0aXZlLCBldGMsIGV0Yy5cbioqL1xubG9nZ2VyLnJlc2V0ID0gZnVuY3Rpb24oKSB7XG4gIC8vIHJlc2V0IHRhcmdldHMgYW5kIGFjdGl2ZSBzdGF0ZXNcbiAgdGFyZ2V0cyA9IFtdO1xuICBhY3RpdmUgPSBbXTtcblxuICByZXR1cm4gbG9nZ2VyLmVuYWJsZSgpO1xufTtcblxuLyoqXG4gICMjIyMgbG9nZ2VyLnRvKHRhcmdldClcblxuICBBZGQgYSBsb2dnaW5nIHRhcmdldC4gIFRoZSBsb2dnZXIgbXVzdCBoYXZlIGEgYGxvZ2AgbWV0aG9kIGF0dGFjaGVkLlxuXG4qKi9cbmxvZ2dlci50byA9IGZ1bmN0aW9uKHRhcmdldCkge1xuICB0YXJnZXRzID0gdGFyZ2V0cy5jb25jYXQodGFyZ2V0IHx8IFtdKTtcblxuICByZXR1cm4gbG9nZ2VyO1xufTtcblxuLyoqXG4gICMjIyMgbG9nZ2VyLmVuYWJsZShuYW1lcyopXG5cbiAgRW5hYmxlIGxvZ2dpbmcgdmlhIHRoZSBuYW1lZCBsb2dnaW5nIGluc3RhbmNlcy4gIFRvIGVuYWJsZSBsb2dnaW5nIHZpYSBhbGxcbiAgaW5zdGFuY2VzLCB5b3UgY2FuIHBhc3MgYSB3aWxkY2FyZDpcblxuICBgYGBqc1xuICBsb2dnZXIuZW5hYmxlKCcqJyk7XG4gIGBgYFxuXG4gIF9fVE9ETzpfXyB3aWxkY2FyZCBlbmFibGVyc1xuKiovXG5sb2dnZXIuZW5hYmxlID0gZnVuY3Rpb24oKSB7XG4gIC8vIHVwZGF0ZSB0aGUgYWN0aXZlXG4gIGFjdGl2ZSA9IGFjdGl2ZS5jb25jYXQoW10uc2xpY2UuY2FsbChhcmd1bWVudHMpKTtcblxuICAvLyB0cmlnZ2VyIHRoZSB1bmxlYXNoIGxpc3RlbmVyc1xuICB1bmxlYXNoTGlzdGVuZXJzLmZvckVhY2goZnVuY3Rpb24obGlzdGVuZXIpIHtcbiAgICBsaXN0ZW5lcigpO1xuICB9KTtcblxuICByZXR1cm4gbG9nZ2VyO1xufTsiLCIvKiBqc2hpbnQgbm9kZTogdHJ1ZSAqL1xuJ3VzZSBzdHJpY3QnO1xuXG4vKipcbiAgIyMgY29nL3Rocm90dGxlXG5cbiAgYGBganNcbiAgdmFyIHRocm90dGxlID0gcmVxdWlyZSgnY29nL3Rocm90dGxlJyk7XG4gIGBgYFxuXG4gICMjIyB0aHJvdHRsZShmbiwgZGVsYXksIG9wdHMpXG5cbiAgQSBjaGVycnktcGlja2FibGUgdGhyb3R0bGUgZnVuY3Rpb24uICBVc2VkIHRvIHRocm90dGxlIGBmbmAgdG8gZW5zdXJlXG4gIHRoYXQgaXQgY2FuIGJlIGNhbGxlZCBhdCBtb3N0IG9uY2UgZXZlcnkgYGRlbGF5YCBtaWxsaXNlY29uZHMuICBXaWxsXG4gIGZpcmUgZmlyc3QgZXZlbnQgaW1tZWRpYXRlbHksIGVuc3VyaW5nIHRoZSBuZXh0IGV2ZW50IGZpcmVkIHdpbGwgb2NjdXJcbiAgYXQgbGVhc3QgYGRlbGF5YCBtaWxsaXNlY29uZHMgYWZ0ZXIgdGhlIGZpcnN0LCBhbmQgc28gb24uXG5cbioqL1xubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihmbiwgZGVsYXksIG9wdHMpIHtcbiAgdmFyIGxhc3RFeGVjID0gKG9wdHMgfHwge30pLmxlYWRpbmcgIT09IGZhbHNlID8gMCA6IERhdGUubm93KCk7XG4gIHZhciB0cmFpbGluZyA9IChvcHRzIHx8IHt9KS50cmFpbGluZztcbiAgdmFyIHRpbWVyO1xuICB2YXIgcXVldWVkQXJncztcbiAgdmFyIHF1ZXVlZFNjb3BlO1xuXG4gIC8vIHRyYWlsaW5nIGRlZmF1bHRzIHRvIHRydWVcbiAgdHJhaWxpbmcgPSB0cmFpbGluZyB8fCB0cmFpbGluZyA9PT0gdW5kZWZpbmVkO1xuICBcbiAgZnVuY3Rpb24gaW52b2tlRGVmZXJlZCgpIHtcbiAgICBmbi5hcHBseShxdWV1ZWRTY29wZSwgcXVldWVkQXJncyB8fCBbXSk7XG4gICAgbGFzdEV4ZWMgPSBEYXRlLm5vdygpO1xuICB9XG5cbiAgcmV0dXJuIGZ1bmN0aW9uKCkge1xuICAgIHZhciB0aWNrID0gRGF0ZS5ub3coKTtcbiAgICB2YXIgZWxhcHNlZCA9IHRpY2sgLSBsYXN0RXhlYztcblxuICAgIC8vIGFsd2F5cyBjbGVhciB0aGUgZGVmZXJlZCB0aW1lclxuICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG5cbiAgICBpZiAoZWxhcHNlZCA8IGRlbGF5KSB7XG4gICAgICBxdWV1ZWRBcmdzID0gW10uc2xpY2UuY2FsbChhcmd1bWVudHMsIDApO1xuICAgICAgcXVldWVkU2NvcGUgPSB0aGlzO1xuXG4gICAgICByZXR1cm4gdHJhaWxpbmcgJiYgKHRpbWVyID0gc2V0VGltZW91dChpbnZva2VEZWZlcmVkLCBkZWxheSAtIGVsYXBzZWQpKTtcbiAgICB9XG5cbiAgICAvLyBjYWxsIHRoZSBmdW5jdGlvblxuICAgIGxhc3RFeGVjID0gdGljaztcbiAgICBmbi5hcHBseSh0aGlzLCBhcmd1bWVudHMpO1xuICB9O1xufTsiLCJ2YXIgZGV0ZWN0QnJvd3NlciA9IHJlcXVpcmUoJy4vbGliL2RldGVjdEJyb3dzZXInKTtcblxubW9kdWxlLmV4cG9ydHMgPSBkZXRlY3RCcm93c2VyKG5hdmlnYXRvci51c2VyQWdlbnQpO1xuIiwibW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiBkZXRlY3RCcm93c2VyKHVzZXJBZ2VudFN0cmluZykge1xuICB2YXIgYnJvd3NlcnMgPSBbXG4gICAgWyAnZWRnZScsIC9FZGdlXFwvKFswLTlcXC5fXSspLyBdLFxuICAgIFsgJ2Nocm9tZScsIC8oPyFDaHJvbS4qT1BSKUNocm9tKD86ZXxpdW0pXFwvKFswLTlcXC5dKykoOj9cXHN8JCkvIF0sXG4gICAgWyAnY3Jpb3MnLCAvQ3JpT1NcXC8oWzAtOVxcLl0rKSg6P1xcc3wkKS8gXSxcbiAgICBbICdmaXJlZm94JywgL0ZpcmVmb3hcXC8oWzAtOVxcLl0rKSg/Olxcc3wkKS8gXSxcbiAgICBbICdvcGVyYScsIC9PcGVyYVxcLyhbMC05XFwuXSspKD86XFxzfCQpLyBdLFxuICAgIFsgJ29wZXJhJywgL09QUlxcLyhbMC05XFwuXSspKDo/XFxzfCQpJC8gXSxcbiAgICBbICdpZScsIC9UcmlkZW50XFwvN1xcLjAuKnJ2XFw6KFswLTlcXC5dKylcXCkuKkdlY2tvJC8gXSxcbiAgICBbICdpZScsIC9NU0lFXFxzKFswLTlcXC5dKyk7LipUcmlkZW50XFwvWzQtN10uMC8gXSxcbiAgICBbICdpZScsIC9NU0lFXFxzKDdcXC4wKS8gXSxcbiAgICBbICdiYjEwJywgL0JCMTA7XFxzVG91Y2guKlZlcnNpb25cXC8oWzAtOVxcLl0rKS8gXSxcbiAgICBbICdhbmRyb2lkJywgL0FuZHJvaWRcXHMoWzAtOVxcLl0rKS8gXSxcbiAgICBbICdpb3MnLCAvaVBhZC4qVmVyc2lvblxcLyhbMC05XFwuX10rKS8gXSxcbiAgICBbICdpb3MnLCAgL2lQaG9uZS4qVmVyc2lvblxcLyhbMC05XFwuX10rKS8gXSxcbiAgICBbICdzYWZhcmknLCAvVmVyc2lvblxcLyhbMC05XFwuX10rKS4qU2FmYXJpLyBdXG4gIF07XG5cbiAgdmFyIGkgPSAwLCBtYXBwZWQgPVtdO1xuICBmb3IgKGkgPSAwOyBpIDwgYnJvd3NlcnMubGVuZ3RoOyBpKyspIHtcbiAgICBicm93c2Vyc1tpXSA9IGNyZWF0ZU1hdGNoKGJyb3dzZXJzW2ldKTtcbiAgICBpZiAoaXNNYXRjaChicm93c2Vyc1tpXSkpIHtcbiAgICAgIG1hcHBlZC5wdXNoKGJyb3dzZXJzW2ldKTtcbiAgICB9XG4gIH1cblxuICB2YXIgbWF0Y2ggPSBtYXBwZWRbMF07XG4gIHZhciBwYXJ0cyA9IG1hdGNoICYmIG1hdGNoWzNdLnNwbGl0KC9bLl9dLykuc2xpY2UoMCwzKTtcblxuICB3aGlsZSAocGFydHMgJiYgcGFydHMubGVuZ3RoIDwgMykge1xuICAgIHBhcnRzLnB1c2goJzAnKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGNyZWF0ZU1hdGNoKHBhaXIpIHtcbiAgICByZXR1cm4gcGFpci5jb25jYXQocGFpclsxXS5leGVjKHVzZXJBZ2VudFN0cmluZykpO1xuICB9XG5cbiAgZnVuY3Rpb24gaXNNYXRjaChwYWlyKSB7XG4gICAgcmV0dXJuICEhcGFpclsyXTtcbiAgfVxuXG4gIC8vIHJldHVybiB0aGUgbmFtZSBhbmQgdmVyc2lvblxuICByZXR1cm4ge1xuICAgIG5hbWU6IG1hdGNoICYmIG1hdGNoWzBdLFxuICAgIHZlcnNpb246IHBhcnRzICYmIHBhcnRzLmpvaW4oJy4nKSxcbiAgfTtcbn07XG4iLCIvKiFcbiAqIEBvdmVydmlldyBlczYtcHJvbWlzZSAtIGEgdGlueSBpbXBsZW1lbnRhdGlvbiBvZiBQcm9taXNlcy9BKy5cbiAqIEBjb3B5cmlnaHQgQ29weXJpZ2h0IChjKSAyMDE0IFllaHVkYSBLYXR6LCBUb20gRGFsZSwgU3RlZmFuIFBlbm5lciBhbmQgY29udHJpYnV0b3JzIChDb252ZXJzaW9uIHRvIEVTNiBBUEkgYnkgSmFrZSBBcmNoaWJhbGQpXG4gKiBAbGljZW5zZSAgIExpY2Vuc2VkIHVuZGVyIE1JVCBsaWNlbnNlXG4gKiAgICAgICAgICAgIFNlZSBodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20vc3RlZmFucGVubmVyL2VzNi1wcm9taXNlL21hc3Rlci9MSUNFTlNFXG4gKiBAdmVyc2lvbiAgIDMuMy4xXG4gKi9cblxuKGZ1bmN0aW9uIChnbG9iYWwsIGZhY3RvcnkpIHtcbiAgICB0eXBlb2YgZXhwb3J0cyA9PT0gJ29iamVjdCcgJiYgdHlwZW9mIG1vZHVsZSAhPT0gJ3VuZGVmaW5lZCcgPyBtb2R1bGUuZXhwb3J0cyA9IGZhY3RvcnkoKSA6XG4gICAgdHlwZW9mIGRlZmluZSA9PT0gJ2Z1bmN0aW9uJyAmJiBkZWZpbmUuYW1kID8gZGVmaW5lKGZhY3RvcnkpIDpcbiAgICAoZ2xvYmFsLkVTNlByb21pc2UgPSBmYWN0b3J5KCkpO1xufSh0aGlzLCAoZnVuY3Rpb24gKCkgeyAndXNlIHN0cmljdCc7XG5cbmZ1bmN0aW9uIG9iamVjdE9yRnVuY3Rpb24oeCkge1xuICByZXR1cm4gdHlwZW9mIHggPT09ICdmdW5jdGlvbicgfHwgdHlwZW9mIHggPT09ICdvYmplY3QnICYmIHggIT09IG51bGw7XG59XG5cbmZ1bmN0aW9uIGlzRnVuY3Rpb24oeCkge1xuICByZXR1cm4gdHlwZW9mIHggPT09ICdmdW5jdGlvbic7XG59XG5cbnZhciBfaXNBcnJheSA9IHVuZGVmaW5lZDtcbmlmICghQXJyYXkuaXNBcnJheSkge1xuICBfaXNBcnJheSA9IGZ1bmN0aW9uICh4KSB7XG4gICAgcmV0dXJuIE9iamVjdC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbCh4KSA9PT0gJ1tvYmplY3QgQXJyYXldJztcbiAgfTtcbn0gZWxzZSB7XG4gIF9pc0FycmF5ID0gQXJyYXkuaXNBcnJheTtcbn1cblxudmFyIGlzQXJyYXkgPSBfaXNBcnJheTtcblxudmFyIGxlbiA9IDA7XG52YXIgdmVydHhOZXh0ID0gdW5kZWZpbmVkO1xudmFyIGN1c3RvbVNjaGVkdWxlckZuID0gdW5kZWZpbmVkO1xuXG52YXIgYXNhcCA9IGZ1bmN0aW9uIGFzYXAoY2FsbGJhY2ssIGFyZykge1xuICBxdWV1ZVtsZW5dID0gY2FsbGJhY2s7XG4gIHF1ZXVlW2xlbiArIDFdID0gYXJnO1xuICBsZW4gKz0gMjtcbiAgaWYgKGxlbiA9PT0gMikge1xuICAgIC8vIElmIGxlbiBpcyAyLCB0aGF0IG1lYW5zIHRoYXQgd2UgbmVlZCB0byBzY2hlZHVsZSBhbiBhc3luYyBmbHVzaC5cbiAgICAvLyBJZiBhZGRpdGlvbmFsIGNhbGxiYWNrcyBhcmUgcXVldWVkIGJlZm9yZSB0aGUgcXVldWUgaXMgZmx1c2hlZCwgdGhleVxuICAgIC8vIHdpbGwgYmUgcHJvY2Vzc2VkIGJ5IHRoaXMgZmx1c2ggdGhhdCB3ZSBhcmUgc2NoZWR1bGluZy5cbiAgICBpZiAoY3VzdG9tU2NoZWR1bGVyRm4pIHtcbiAgICAgIGN1c3RvbVNjaGVkdWxlckZuKGZsdXNoKTtcbiAgICB9IGVsc2Uge1xuICAgICAgc2NoZWR1bGVGbHVzaCgpO1xuICAgIH1cbiAgfVxufTtcblxuZnVuY3Rpb24gc2V0U2NoZWR1bGVyKHNjaGVkdWxlRm4pIHtcbiAgY3VzdG9tU2NoZWR1bGVyRm4gPSBzY2hlZHVsZUZuO1xufVxuXG5mdW5jdGlvbiBzZXRBc2FwKGFzYXBGbikge1xuICBhc2FwID0gYXNhcEZuO1xufVxuXG52YXIgYnJvd3NlcldpbmRvdyA9IHR5cGVvZiB3aW5kb3cgIT09ICd1bmRlZmluZWQnID8gd2luZG93IDogdW5kZWZpbmVkO1xudmFyIGJyb3dzZXJHbG9iYWwgPSBicm93c2VyV2luZG93IHx8IHt9O1xudmFyIEJyb3dzZXJNdXRhdGlvbk9ic2VydmVyID0gYnJvd3Nlckdsb2JhbC5NdXRhdGlvbk9ic2VydmVyIHx8IGJyb3dzZXJHbG9iYWwuV2ViS2l0TXV0YXRpb25PYnNlcnZlcjtcbnZhciBpc05vZGUgPSB0eXBlb2Ygc2VsZiA9PT0gJ3VuZGVmaW5lZCcgJiYgdHlwZW9mIHByb2Nlc3MgIT09ICd1bmRlZmluZWQnICYmICh7fSkudG9TdHJpbmcuY2FsbChwcm9jZXNzKSA9PT0gJ1tvYmplY3QgcHJvY2Vzc10nO1xuXG4vLyB0ZXN0IGZvciB3ZWIgd29ya2VyIGJ1dCBub3QgaW4gSUUxMFxudmFyIGlzV29ya2VyID0gdHlwZW9mIFVpbnQ4Q2xhbXBlZEFycmF5ICE9PSAndW5kZWZpbmVkJyAmJiB0eXBlb2YgaW1wb3J0U2NyaXB0cyAhPT0gJ3VuZGVmaW5lZCcgJiYgdHlwZW9mIE1lc3NhZ2VDaGFubmVsICE9PSAndW5kZWZpbmVkJztcblxuLy8gbm9kZVxuZnVuY3Rpb24gdXNlTmV4dFRpY2soKSB7XG4gIC8vIG5vZGUgdmVyc2lvbiAwLjEwLnggZGlzcGxheXMgYSBkZXByZWNhdGlvbiB3YXJuaW5nIHdoZW4gbmV4dFRpY2sgaXMgdXNlZCByZWN1cnNpdmVseVxuICAvLyBzZWUgaHR0cHM6Ly9naXRodWIuY29tL2N1am9qcy93aGVuL2lzc3Vlcy80MTAgZm9yIGRldGFpbHNcbiAgcmV0dXJuIGZ1bmN0aW9uICgpIHtcbiAgICByZXR1cm4gcHJvY2Vzcy5uZXh0VGljayhmbHVzaCk7XG4gIH07XG59XG5cbi8vIHZlcnR4XG5mdW5jdGlvbiB1c2VWZXJ0eFRpbWVyKCkge1xuICByZXR1cm4gZnVuY3Rpb24gKCkge1xuICAgIHZlcnR4TmV4dChmbHVzaCk7XG4gIH07XG59XG5cbmZ1bmN0aW9uIHVzZU11dGF0aW9uT2JzZXJ2ZXIoKSB7XG4gIHZhciBpdGVyYXRpb25zID0gMDtcbiAgdmFyIG9ic2VydmVyID0gbmV3IEJyb3dzZXJNdXRhdGlvbk9ic2VydmVyKGZsdXNoKTtcbiAgdmFyIG5vZGUgPSBkb2N1bWVudC5jcmVhdGVUZXh0Tm9kZSgnJyk7XG4gIG9ic2VydmVyLm9ic2VydmUobm9kZSwgeyBjaGFyYWN0ZXJEYXRhOiB0cnVlIH0pO1xuXG4gIHJldHVybiBmdW5jdGlvbiAoKSB7XG4gICAgbm9kZS5kYXRhID0gaXRlcmF0aW9ucyA9ICsraXRlcmF0aW9ucyAlIDI7XG4gIH07XG59XG5cbi8vIHdlYiB3b3JrZXJcbmZ1bmN0aW9uIHVzZU1lc3NhZ2VDaGFubmVsKCkge1xuICB2YXIgY2hhbm5lbCA9IG5ldyBNZXNzYWdlQ2hhbm5lbCgpO1xuICBjaGFubmVsLnBvcnQxLm9ubWVzc2FnZSA9IGZsdXNoO1xuICByZXR1cm4gZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiBjaGFubmVsLnBvcnQyLnBvc3RNZXNzYWdlKDApO1xuICB9O1xufVxuXG5mdW5jdGlvbiB1c2VTZXRUaW1lb3V0KCkge1xuICAvLyBTdG9yZSBzZXRUaW1lb3V0IHJlZmVyZW5jZSBzbyBlczYtcHJvbWlzZSB3aWxsIGJlIHVuYWZmZWN0ZWQgYnlcbiAgLy8gb3RoZXIgY29kZSBtb2RpZnlpbmcgc2V0VGltZW91dCAobGlrZSBzaW5vbi51c2VGYWtlVGltZXJzKCkpXG4gIHZhciBnbG9iYWxTZXRUaW1lb3V0ID0gc2V0VGltZW91dDtcbiAgcmV0dXJuIGZ1bmN0aW9uICgpIHtcbiAgICByZXR1cm4gZ2xvYmFsU2V0VGltZW91dChmbHVzaCwgMSk7XG4gIH07XG59XG5cbnZhciBxdWV1ZSA9IG5ldyBBcnJheSgxMDAwKTtcbmZ1bmN0aW9uIGZsdXNoKCkge1xuICBmb3IgKHZhciBpID0gMDsgaSA8IGxlbjsgaSArPSAyKSB7XG4gICAgdmFyIGNhbGxiYWNrID0gcXVldWVbaV07XG4gICAgdmFyIGFyZyA9IHF1ZXVlW2kgKyAxXTtcblxuICAgIGNhbGxiYWNrKGFyZyk7XG5cbiAgICBxdWV1ZVtpXSA9IHVuZGVmaW5lZDtcbiAgICBxdWV1ZVtpICsgMV0gPSB1bmRlZmluZWQ7XG4gIH1cblxuICBsZW4gPSAwO1xufVxuXG5mdW5jdGlvbiBhdHRlbXB0VmVydHgoKSB7XG4gIHRyeSB7XG4gICAgdmFyIHIgPSByZXF1aXJlO1xuICAgIHZhciB2ZXJ0eCA9IHIoJ3ZlcnR4Jyk7XG4gICAgdmVydHhOZXh0ID0gdmVydHgucnVuT25Mb29wIHx8IHZlcnR4LnJ1bk9uQ29udGV4dDtcbiAgICByZXR1cm4gdXNlVmVydHhUaW1lcigpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgcmV0dXJuIHVzZVNldFRpbWVvdXQoKTtcbiAgfVxufVxuXG52YXIgc2NoZWR1bGVGbHVzaCA9IHVuZGVmaW5lZDtcbi8vIERlY2lkZSB3aGF0IGFzeW5jIG1ldGhvZCB0byB1c2UgdG8gdHJpZ2dlcmluZyBwcm9jZXNzaW5nIG9mIHF1ZXVlZCBjYWxsYmFja3M6XG5pZiAoaXNOb2RlKSB7XG4gIHNjaGVkdWxlRmx1c2ggPSB1c2VOZXh0VGljaygpO1xufSBlbHNlIGlmIChCcm93c2VyTXV0YXRpb25PYnNlcnZlcikge1xuICBzY2hlZHVsZUZsdXNoID0gdXNlTXV0YXRpb25PYnNlcnZlcigpO1xufSBlbHNlIGlmIChpc1dvcmtlcikge1xuICBzY2hlZHVsZUZsdXNoID0gdXNlTWVzc2FnZUNoYW5uZWwoKTtcbn0gZWxzZSBpZiAoYnJvd3NlcldpbmRvdyA9PT0gdW5kZWZpbmVkICYmIHR5cGVvZiByZXF1aXJlID09PSAnZnVuY3Rpb24nKSB7XG4gIHNjaGVkdWxlRmx1c2ggPSBhdHRlbXB0VmVydHgoKTtcbn0gZWxzZSB7XG4gIHNjaGVkdWxlRmx1c2ggPSB1c2VTZXRUaW1lb3V0KCk7XG59XG5cbmZ1bmN0aW9uIHRoZW4ob25GdWxmaWxsbWVudCwgb25SZWplY3Rpb24pIHtcbiAgdmFyIF9hcmd1bWVudHMgPSBhcmd1bWVudHM7XG5cbiAgdmFyIHBhcmVudCA9IHRoaXM7XG5cbiAgdmFyIGNoaWxkID0gbmV3IHRoaXMuY29uc3RydWN0b3Iobm9vcCk7XG5cbiAgaWYgKGNoaWxkW1BST01JU0VfSURdID09PSB1bmRlZmluZWQpIHtcbiAgICBtYWtlUHJvbWlzZShjaGlsZCk7XG4gIH1cblxuICB2YXIgX3N0YXRlID0gcGFyZW50Ll9zdGF0ZTtcblxuICBpZiAoX3N0YXRlKSB7XG4gICAgKGZ1bmN0aW9uICgpIHtcbiAgICAgIHZhciBjYWxsYmFjayA9IF9hcmd1bWVudHNbX3N0YXRlIC0gMV07XG4gICAgICBhc2FwKGZ1bmN0aW9uICgpIHtcbiAgICAgICAgcmV0dXJuIGludm9rZUNhbGxiYWNrKF9zdGF0ZSwgY2hpbGQsIGNhbGxiYWNrLCBwYXJlbnQuX3Jlc3VsdCk7XG4gICAgICB9KTtcbiAgICB9KSgpO1xuICB9IGVsc2Uge1xuICAgIHN1YnNjcmliZShwYXJlbnQsIGNoaWxkLCBvbkZ1bGZpbGxtZW50LCBvblJlamVjdGlvbik7XG4gIH1cblxuICByZXR1cm4gY2hpbGQ7XG59XG5cbi8qKlxuICBgUHJvbWlzZS5yZXNvbHZlYCByZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHdpbGwgYmVjb21lIHJlc29sdmVkIHdpdGggdGhlXG4gIHBhc3NlZCBgdmFsdWVgLiBJdCBpcyBzaG9ydGhhbmQgZm9yIHRoZSBmb2xsb3dpbmc6XG5cbiAgYGBgamF2YXNjcmlwdFxuICBsZXQgcHJvbWlzZSA9IG5ldyBQcm9taXNlKGZ1bmN0aW9uKHJlc29sdmUsIHJlamVjdCl7XG4gICAgcmVzb2x2ZSgxKTtcbiAgfSk7XG5cbiAgcHJvbWlzZS50aGVuKGZ1bmN0aW9uKHZhbHVlKXtcbiAgICAvLyB2YWx1ZSA9PT0gMVxuICB9KTtcbiAgYGBgXG5cbiAgSW5zdGVhZCBvZiB3cml0aW5nIHRoZSBhYm92ZSwgeW91ciBjb2RlIG5vdyBzaW1wbHkgYmVjb21lcyB0aGUgZm9sbG93aW5nOlxuXG4gIGBgYGphdmFzY3JpcHRcbiAgbGV0IHByb21pc2UgPSBQcm9taXNlLnJlc29sdmUoMSk7XG5cbiAgcHJvbWlzZS50aGVuKGZ1bmN0aW9uKHZhbHVlKXtcbiAgICAvLyB2YWx1ZSA9PT0gMVxuICB9KTtcbiAgYGBgXG5cbiAgQG1ldGhvZCByZXNvbHZlXG4gIEBzdGF0aWNcbiAgQHBhcmFtIHtBbnl9IHZhbHVlIHZhbHVlIHRoYXQgdGhlIHJldHVybmVkIHByb21pc2Ugd2lsbCBiZSByZXNvbHZlZCB3aXRoXG4gIFVzZWZ1bCBmb3IgdG9vbGluZy5cbiAgQHJldHVybiB7UHJvbWlzZX0gYSBwcm9taXNlIHRoYXQgd2lsbCBiZWNvbWUgZnVsZmlsbGVkIHdpdGggdGhlIGdpdmVuXG4gIGB2YWx1ZWBcbiovXG5mdW5jdGlvbiByZXNvbHZlKG9iamVjdCkge1xuICAvKmpzaGludCB2YWxpZHRoaXM6dHJ1ZSAqL1xuICB2YXIgQ29uc3RydWN0b3IgPSB0aGlzO1xuXG4gIGlmIChvYmplY3QgJiYgdHlwZW9mIG9iamVjdCA9PT0gJ29iamVjdCcgJiYgb2JqZWN0LmNvbnN0cnVjdG9yID09PSBDb25zdHJ1Y3Rvcikge1xuICAgIHJldHVybiBvYmplY3Q7XG4gIH1cblxuICB2YXIgcHJvbWlzZSA9IG5ldyBDb25zdHJ1Y3Rvcihub29wKTtcbiAgX3Jlc29sdmUocHJvbWlzZSwgb2JqZWN0KTtcbiAgcmV0dXJuIHByb21pc2U7XG59XG5cbnZhciBQUk9NSVNFX0lEID0gTWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc3Vic3RyaW5nKDE2KTtcblxuZnVuY3Rpb24gbm9vcCgpIHt9XG5cbnZhciBQRU5ESU5HID0gdm9pZCAwO1xudmFyIEZVTEZJTExFRCA9IDE7XG52YXIgUkVKRUNURUQgPSAyO1xuXG52YXIgR0VUX1RIRU5fRVJST1IgPSBuZXcgRXJyb3JPYmplY3QoKTtcblxuZnVuY3Rpb24gc2VsZkZ1bGZpbGxtZW50KCkge1xuICByZXR1cm4gbmV3IFR5cGVFcnJvcihcIllvdSBjYW5ub3QgcmVzb2x2ZSBhIHByb21pc2Ugd2l0aCBpdHNlbGZcIik7XG59XG5cbmZ1bmN0aW9uIGNhbm5vdFJldHVybk93bigpIHtcbiAgcmV0dXJuIG5ldyBUeXBlRXJyb3IoJ0EgcHJvbWlzZXMgY2FsbGJhY2sgY2Fubm90IHJldHVybiB0aGF0IHNhbWUgcHJvbWlzZS4nKTtcbn1cblxuZnVuY3Rpb24gZ2V0VGhlbihwcm9taXNlKSB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIHByb21pc2UudGhlbjtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBHRVRfVEhFTl9FUlJPUi5lcnJvciA9IGVycm9yO1xuICAgIHJldHVybiBHRVRfVEhFTl9FUlJPUjtcbiAgfVxufVxuXG5mdW5jdGlvbiB0cnlUaGVuKHRoZW4sIHZhbHVlLCBmdWxmaWxsbWVudEhhbmRsZXIsIHJlamVjdGlvbkhhbmRsZXIpIHtcbiAgdHJ5IHtcbiAgICB0aGVuLmNhbGwodmFsdWUsIGZ1bGZpbGxtZW50SGFuZGxlciwgcmVqZWN0aW9uSGFuZGxlcik7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICByZXR1cm4gZTtcbiAgfVxufVxuXG5mdW5jdGlvbiBoYW5kbGVGb3JlaWduVGhlbmFibGUocHJvbWlzZSwgdGhlbmFibGUsIHRoZW4pIHtcbiAgYXNhcChmdW5jdGlvbiAocHJvbWlzZSkge1xuICAgIHZhciBzZWFsZWQgPSBmYWxzZTtcbiAgICB2YXIgZXJyb3IgPSB0cnlUaGVuKHRoZW4sIHRoZW5hYmxlLCBmdW5jdGlvbiAodmFsdWUpIHtcbiAgICAgIGlmIChzZWFsZWQpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgc2VhbGVkID0gdHJ1ZTtcbiAgICAgIGlmICh0aGVuYWJsZSAhPT0gdmFsdWUpIHtcbiAgICAgICAgX3Jlc29sdmUocHJvbWlzZSwgdmFsdWUpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgZnVsZmlsbChwcm9taXNlLCB2YWx1ZSk7XG4gICAgICB9XG4gICAgfSwgZnVuY3Rpb24gKHJlYXNvbikge1xuICAgICAgaWYgKHNlYWxlZCkge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBzZWFsZWQgPSB0cnVlO1xuXG4gICAgICBfcmVqZWN0KHByb21pc2UsIHJlYXNvbik7XG4gICAgfSwgJ1NldHRsZTogJyArIChwcm9taXNlLl9sYWJlbCB8fCAnIHVua25vd24gcHJvbWlzZScpKTtcblxuICAgIGlmICghc2VhbGVkICYmIGVycm9yKSB7XG4gICAgICBzZWFsZWQgPSB0cnVlO1xuICAgICAgX3JlamVjdChwcm9taXNlLCBlcnJvcik7XG4gICAgfVxuICB9LCBwcm9taXNlKTtcbn1cblxuZnVuY3Rpb24gaGFuZGxlT3duVGhlbmFibGUocHJvbWlzZSwgdGhlbmFibGUpIHtcbiAgaWYgKHRoZW5hYmxlLl9zdGF0ZSA9PT0gRlVMRklMTEVEKSB7XG4gICAgZnVsZmlsbChwcm9taXNlLCB0aGVuYWJsZS5fcmVzdWx0KTtcbiAgfSBlbHNlIGlmICh0aGVuYWJsZS5fc3RhdGUgPT09IFJFSkVDVEVEKSB7XG4gICAgX3JlamVjdChwcm9taXNlLCB0aGVuYWJsZS5fcmVzdWx0KTtcbiAgfSBlbHNlIHtcbiAgICBzdWJzY3JpYmUodGhlbmFibGUsIHVuZGVmaW5lZCwgZnVuY3Rpb24gKHZhbHVlKSB7XG4gICAgICByZXR1cm4gX3Jlc29sdmUocHJvbWlzZSwgdmFsdWUpO1xuICAgIH0sIGZ1bmN0aW9uIChyZWFzb24pIHtcbiAgICAgIHJldHVybiBfcmVqZWN0KHByb21pc2UsIHJlYXNvbik7XG4gICAgfSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gaGFuZGxlTWF5YmVUaGVuYWJsZShwcm9taXNlLCBtYXliZVRoZW5hYmxlLCB0aGVuJCQpIHtcbiAgaWYgKG1heWJlVGhlbmFibGUuY29uc3RydWN0b3IgPT09IHByb21pc2UuY29uc3RydWN0b3IgJiYgdGhlbiQkID09PSB0aGVuICYmIG1heWJlVGhlbmFibGUuY29uc3RydWN0b3IucmVzb2x2ZSA9PT0gcmVzb2x2ZSkge1xuICAgIGhhbmRsZU93blRoZW5hYmxlKHByb21pc2UsIG1heWJlVGhlbmFibGUpO1xuICB9IGVsc2Uge1xuICAgIGlmICh0aGVuJCQgPT09IEdFVF9USEVOX0VSUk9SKSB7XG4gICAgICBfcmVqZWN0KHByb21pc2UsIEdFVF9USEVOX0VSUk9SLmVycm9yKTtcbiAgICB9IGVsc2UgaWYgKHRoZW4kJCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBmdWxmaWxsKHByb21pc2UsIG1heWJlVGhlbmFibGUpO1xuICAgIH0gZWxzZSBpZiAoaXNGdW5jdGlvbih0aGVuJCQpKSB7XG4gICAgICBoYW5kbGVGb3JlaWduVGhlbmFibGUocHJvbWlzZSwgbWF5YmVUaGVuYWJsZSwgdGhlbiQkKTtcbiAgICB9IGVsc2Uge1xuICAgICAgZnVsZmlsbChwcm9taXNlLCBtYXliZVRoZW5hYmxlKTtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gX3Jlc29sdmUocHJvbWlzZSwgdmFsdWUpIHtcbiAgaWYgKHByb21pc2UgPT09IHZhbHVlKSB7XG4gICAgX3JlamVjdChwcm9taXNlLCBzZWxmRnVsZmlsbG1lbnQoKSk7XG4gIH0gZWxzZSBpZiAob2JqZWN0T3JGdW5jdGlvbih2YWx1ZSkpIHtcbiAgICBoYW5kbGVNYXliZVRoZW5hYmxlKHByb21pc2UsIHZhbHVlLCBnZXRUaGVuKHZhbHVlKSk7XG4gIH0gZWxzZSB7XG4gICAgZnVsZmlsbChwcm9taXNlLCB2YWx1ZSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gcHVibGlzaFJlamVjdGlvbihwcm9taXNlKSB7XG4gIGlmIChwcm9taXNlLl9vbmVycm9yKSB7XG4gICAgcHJvbWlzZS5fb25lcnJvcihwcm9taXNlLl9yZXN1bHQpO1xuICB9XG5cbiAgcHVibGlzaChwcm9taXNlKTtcbn1cblxuZnVuY3Rpb24gZnVsZmlsbChwcm9taXNlLCB2YWx1ZSkge1xuICBpZiAocHJvbWlzZS5fc3RhdGUgIT09IFBFTkRJTkcpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBwcm9taXNlLl9yZXN1bHQgPSB2YWx1ZTtcbiAgcHJvbWlzZS5fc3RhdGUgPSBGVUxGSUxMRUQ7XG5cbiAgaWYgKHByb21pc2UuX3N1YnNjcmliZXJzLmxlbmd0aCAhPT0gMCkge1xuICAgIGFzYXAocHVibGlzaCwgcHJvbWlzZSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gX3JlamVjdChwcm9taXNlLCByZWFzb24pIHtcbiAgaWYgKHByb21pc2UuX3N0YXRlICE9PSBQRU5ESU5HKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIHByb21pc2UuX3N0YXRlID0gUkVKRUNURUQ7XG4gIHByb21pc2UuX3Jlc3VsdCA9IHJlYXNvbjtcblxuICBhc2FwKHB1Ymxpc2hSZWplY3Rpb24sIHByb21pc2UpO1xufVxuXG5mdW5jdGlvbiBzdWJzY3JpYmUocGFyZW50LCBjaGlsZCwgb25GdWxmaWxsbWVudCwgb25SZWplY3Rpb24pIHtcbiAgdmFyIF9zdWJzY3JpYmVycyA9IHBhcmVudC5fc3Vic2NyaWJlcnM7XG4gIHZhciBsZW5ndGggPSBfc3Vic2NyaWJlcnMubGVuZ3RoO1xuXG4gIHBhcmVudC5fb25lcnJvciA9IG51bGw7XG5cbiAgX3N1YnNjcmliZXJzW2xlbmd0aF0gPSBjaGlsZDtcbiAgX3N1YnNjcmliZXJzW2xlbmd0aCArIEZVTEZJTExFRF0gPSBvbkZ1bGZpbGxtZW50O1xuICBfc3Vic2NyaWJlcnNbbGVuZ3RoICsgUkVKRUNURURdID0gb25SZWplY3Rpb247XG5cbiAgaWYgKGxlbmd0aCA9PT0gMCAmJiBwYXJlbnQuX3N0YXRlKSB7XG4gICAgYXNhcChwdWJsaXNoLCBwYXJlbnQpO1xuICB9XG59XG5cbmZ1bmN0aW9uIHB1Ymxpc2gocHJvbWlzZSkge1xuICB2YXIgc3Vic2NyaWJlcnMgPSBwcm9taXNlLl9zdWJzY3JpYmVycztcbiAgdmFyIHNldHRsZWQgPSBwcm9taXNlLl9zdGF0ZTtcblxuICBpZiAoc3Vic2NyaWJlcnMubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgdmFyIGNoaWxkID0gdW5kZWZpbmVkLFxuICAgICAgY2FsbGJhY2sgPSB1bmRlZmluZWQsXG4gICAgICBkZXRhaWwgPSBwcm9taXNlLl9yZXN1bHQ7XG5cbiAgZm9yICh2YXIgaSA9IDA7IGkgPCBzdWJzY3JpYmVycy5sZW5ndGg7IGkgKz0gMykge1xuICAgIGNoaWxkID0gc3Vic2NyaWJlcnNbaV07XG4gICAgY2FsbGJhY2sgPSBzdWJzY3JpYmVyc1tpICsgc2V0dGxlZF07XG5cbiAgICBpZiAoY2hpbGQpIHtcbiAgICAgIGludm9rZUNhbGxiYWNrKHNldHRsZWQsIGNoaWxkLCBjYWxsYmFjaywgZGV0YWlsKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY2FsbGJhY2soZGV0YWlsKTtcbiAgICB9XG4gIH1cblxuICBwcm9taXNlLl9zdWJzY3JpYmVycy5sZW5ndGggPSAwO1xufVxuXG5mdW5jdGlvbiBFcnJvck9iamVjdCgpIHtcbiAgdGhpcy5lcnJvciA9IG51bGw7XG59XG5cbnZhciBUUllfQ0FUQ0hfRVJST1IgPSBuZXcgRXJyb3JPYmplY3QoKTtcblxuZnVuY3Rpb24gdHJ5Q2F0Y2goY2FsbGJhY2ssIGRldGFpbCkge1xuICB0cnkge1xuICAgIHJldHVybiBjYWxsYmFjayhkZXRhaWwpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgVFJZX0NBVENIX0VSUk9SLmVycm9yID0gZTtcbiAgICByZXR1cm4gVFJZX0NBVENIX0VSUk9SO1xuICB9XG59XG5cbmZ1bmN0aW9uIGludm9rZUNhbGxiYWNrKHNldHRsZWQsIHByb21pc2UsIGNhbGxiYWNrLCBkZXRhaWwpIHtcbiAgdmFyIGhhc0NhbGxiYWNrID0gaXNGdW5jdGlvbihjYWxsYmFjayksXG4gICAgICB2YWx1ZSA9IHVuZGVmaW5lZCxcbiAgICAgIGVycm9yID0gdW5kZWZpbmVkLFxuICAgICAgc3VjY2VlZGVkID0gdW5kZWZpbmVkLFxuICAgICAgZmFpbGVkID0gdW5kZWZpbmVkO1xuXG4gIGlmIChoYXNDYWxsYmFjaykge1xuICAgIHZhbHVlID0gdHJ5Q2F0Y2goY2FsbGJhY2ssIGRldGFpbCk7XG5cbiAgICBpZiAodmFsdWUgPT09IFRSWV9DQVRDSF9FUlJPUikge1xuICAgICAgZmFpbGVkID0gdHJ1ZTtcbiAgICAgIGVycm9yID0gdmFsdWUuZXJyb3I7XG4gICAgICB2YWx1ZSA9IG51bGw7XG4gICAgfSBlbHNlIHtcbiAgICAgIHN1Y2NlZWRlZCA9IHRydWU7XG4gICAgfVxuXG4gICAgaWYgKHByb21pc2UgPT09IHZhbHVlKSB7XG4gICAgICBfcmVqZWN0KHByb21pc2UsIGNhbm5vdFJldHVybk93bigpKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgdmFsdWUgPSBkZXRhaWw7XG4gICAgc3VjY2VlZGVkID0gdHJ1ZTtcbiAgfVxuXG4gIGlmIChwcm9taXNlLl9zdGF0ZSAhPT0gUEVORElORykge1xuICAgIC8vIG5vb3BcbiAgfSBlbHNlIGlmIChoYXNDYWxsYmFjayAmJiBzdWNjZWVkZWQpIHtcbiAgICAgIF9yZXNvbHZlKHByb21pc2UsIHZhbHVlKTtcbiAgICB9IGVsc2UgaWYgKGZhaWxlZCkge1xuICAgICAgX3JlamVjdChwcm9taXNlLCBlcnJvcik7XG4gICAgfSBlbHNlIGlmIChzZXR0bGVkID09PSBGVUxGSUxMRUQpIHtcbiAgICAgIGZ1bGZpbGwocHJvbWlzZSwgdmFsdWUpO1xuICAgIH0gZWxzZSBpZiAoc2V0dGxlZCA9PT0gUkVKRUNURUQpIHtcbiAgICAgIF9yZWplY3QocHJvbWlzZSwgdmFsdWUpO1xuICAgIH1cbn1cblxuZnVuY3Rpb24gaW5pdGlhbGl6ZVByb21pc2UocHJvbWlzZSwgcmVzb2x2ZXIpIHtcbiAgdHJ5IHtcbiAgICByZXNvbHZlcihmdW5jdGlvbiByZXNvbHZlUHJvbWlzZSh2YWx1ZSkge1xuICAgICAgX3Jlc29sdmUocHJvbWlzZSwgdmFsdWUpO1xuICAgIH0sIGZ1bmN0aW9uIHJlamVjdFByb21pc2UocmVhc29uKSB7XG4gICAgICBfcmVqZWN0KHByb21pc2UsIHJlYXNvbik7XG4gICAgfSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBfcmVqZWN0KHByb21pc2UsIGUpO1xuICB9XG59XG5cbnZhciBpZCA9IDA7XG5mdW5jdGlvbiBuZXh0SWQoKSB7XG4gIHJldHVybiBpZCsrO1xufVxuXG5mdW5jdGlvbiBtYWtlUHJvbWlzZShwcm9taXNlKSB7XG4gIHByb21pc2VbUFJPTUlTRV9JRF0gPSBpZCsrO1xuICBwcm9taXNlLl9zdGF0ZSA9IHVuZGVmaW5lZDtcbiAgcHJvbWlzZS5fcmVzdWx0ID0gdW5kZWZpbmVkO1xuICBwcm9taXNlLl9zdWJzY3JpYmVycyA9IFtdO1xufVxuXG5mdW5jdGlvbiBFbnVtZXJhdG9yKENvbnN0cnVjdG9yLCBpbnB1dCkge1xuICB0aGlzLl9pbnN0YW5jZUNvbnN0cnVjdG9yID0gQ29uc3RydWN0b3I7XG4gIHRoaXMucHJvbWlzZSA9IG5ldyBDb25zdHJ1Y3Rvcihub29wKTtcblxuICBpZiAoIXRoaXMucHJvbWlzZVtQUk9NSVNFX0lEXSkge1xuICAgIG1ha2VQcm9taXNlKHRoaXMucHJvbWlzZSk7XG4gIH1cblxuICBpZiAoaXNBcnJheShpbnB1dCkpIHtcbiAgICB0aGlzLl9pbnB1dCA9IGlucHV0O1xuICAgIHRoaXMubGVuZ3RoID0gaW5wdXQubGVuZ3RoO1xuICAgIHRoaXMuX3JlbWFpbmluZyA9IGlucHV0Lmxlbmd0aDtcblxuICAgIHRoaXMuX3Jlc3VsdCA9IG5ldyBBcnJheSh0aGlzLmxlbmd0aCk7XG5cbiAgICBpZiAodGhpcy5sZW5ndGggPT09IDApIHtcbiAgICAgIGZ1bGZpbGwodGhpcy5wcm9taXNlLCB0aGlzLl9yZXN1bHQpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLmxlbmd0aCA9IHRoaXMubGVuZ3RoIHx8IDA7XG4gICAgICB0aGlzLl9lbnVtZXJhdGUoKTtcbiAgICAgIGlmICh0aGlzLl9yZW1haW5pbmcgPT09IDApIHtcbiAgICAgICAgZnVsZmlsbCh0aGlzLnByb21pc2UsIHRoaXMuX3Jlc3VsdCk7XG4gICAgICB9XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIF9yZWplY3QodGhpcy5wcm9taXNlLCB2YWxpZGF0aW9uRXJyb3IoKSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdmFsaWRhdGlvbkVycm9yKCkge1xuICByZXR1cm4gbmV3IEVycm9yKCdBcnJheSBNZXRob2RzIG11c3QgYmUgcHJvdmlkZWQgYW4gQXJyYXknKTtcbn07XG5cbkVudW1lcmF0b3IucHJvdG90eXBlLl9lbnVtZXJhdGUgPSBmdW5jdGlvbiAoKSB7XG4gIHZhciBsZW5ndGggPSB0aGlzLmxlbmd0aDtcbiAgdmFyIF9pbnB1dCA9IHRoaXMuX2lucHV0O1xuXG4gIGZvciAodmFyIGkgPSAwOyB0aGlzLl9zdGF0ZSA9PT0gUEVORElORyAmJiBpIDwgbGVuZ3RoOyBpKyspIHtcbiAgICB0aGlzLl9lYWNoRW50cnkoX2lucHV0W2ldLCBpKTtcbiAgfVxufTtcblxuRW51bWVyYXRvci5wcm90b3R5cGUuX2VhY2hFbnRyeSA9IGZ1bmN0aW9uIChlbnRyeSwgaSkge1xuICB2YXIgYyA9IHRoaXMuX2luc3RhbmNlQ29uc3RydWN0b3I7XG4gIHZhciByZXNvbHZlJCQgPSBjLnJlc29sdmU7XG5cbiAgaWYgKHJlc29sdmUkJCA9PT0gcmVzb2x2ZSkge1xuICAgIHZhciBfdGhlbiA9IGdldFRoZW4oZW50cnkpO1xuXG4gICAgaWYgKF90aGVuID09PSB0aGVuICYmIGVudHJ5Ll9zdGF0ZSAhPT0gUEVORElORykge1xuICAgICAgdGhpcy5fc2V0dGxlZEF0KGVudHJ5Ll9zdGF0ZSwgaSwgZW50cnkuX3Jlc3VsdCk7XG4gICAgfSBlbHNlIGlmICh0eXBlb2YgX3RoZW4gIT09ICdmdW5jdGlvbicpIHtcbiAgICAgIHRoaXMuX3JlbWFpbmluZy0tO1xuICAgICAgdGhpcy5fcmVzdWx0W2ldID0gZW50cnk7XG4gICAgfSBlbHNlIGlmIChjID09PSBQcm9taXNlKSB7XG4gICAgICB2YXIgcHJvbWlzZSA9IG5ldyBjKG5vb3ApO1xuICAgICAgaGFuZGxlTWF5YmVUaGVuYWJsZShwcm9taXNlLCBlbnRyeSwgX3RoZW4pO1xuICAgICAgdGhpcy5fd2lsbFNldHRsZUF0KHByb21pc2UsIGkpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLl93aWxsU2V0dGxlQXQobmV3IGMoZnVuY3Rpb24gKHJlc29sdmUkJCkge1xuICAgICAgICByZXR1cm4gcmVzb2x2ZSQkKGVudHJ5KTtcbiAgICAgIH0pLCBpKTtcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgdGhpcy5fd2lsbFNldHRsZUF0KHJlc29sdmUkJChlbnRyeSksIGkpO1xuICB9XG59O1xuXG5FbnVtZXJhdG9yLnByb3RvdHlwZS5fc2V0dGxlZEF0ID0gZnVuY3Rpb24gKHN0YXRlLCBpLCB2YWx1ZSkge1xuICB2YXIgcHJvbWlzZSA9IHRoaXMucHJvbWlzZTtcblxuICBpZiAocHJvbWlzZS5fc3RhdGUgPT09IFBFTkRJTkcpIHtcbiAgICB0aGlzLl9yZW1haW5pbmctLTtcblxuICAgIGlmIChzdGF0ZSA9PT0gUkVKRUNURUQpIHtcbiAgICAgIF9yZWplY3QocHJvbWlzZSwgdmFsdWUpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLl9yZXN1bHRbaV0gPSB2YWx1ZTtcbiAgICB9XG4gIH1cblxuICBpZiAodGhpcy5fcmVtYWluaW5nID09PSAwKSB7XG4gICAgZnVsZmlsbChwcm9taXNlLCB0aGlzLl9yZXN1bHQpO1xuICB9XG59O1xuXG5FbnVtZXJhdG9yLnByb3RvdHlwZS5fd2lsbFNldHRsZUF0ID0gZnVuY3Rpb24gKHByb21pc2UsIGkpIHtcbiAgdmFyIGVudW1lcmF0b3IgPSB0aGlzO1xuXG4gIHN1YnNjcmliZShwcm9taXNlLCB1bmRlZmluZWQsIGZ1bmN0aW9uICh2YWx1ZSkge1xuICAgIHJldHVybiBlbnVtZXJhdG9yLl9zZXR0bGVkQXQoRlVMRklMTEVELCBpLCB2YWx1ZSk7XG4gIH0sIGZ1bmN0aW9uIChyZWFzb24pIHtcbiAgICByZXR1cm4gZW51bWVyYXRvci5fc2V0dGxlZEF0KFJFSkVDVEVELCBpLCByZWFzb24pO1xuICB9KTtcbn07XG5cbi8qKlxuICBgUHJvbWlzZS5hbGxgIGFjY2VwdHMgYW4gYXJyYXkgb2YgcHJvbWlzZXMsIGFuZCByZXR1cm5zIGEgbmV3IHByb21pc2Ugd2hpY2hcbiAgaXMgZnVsZmlsbGVkIHdpdGggYW4gYXJyYXkgb2YgZnVsZmlsbG1lbnQgdmFsdWVzIGZvciB0aGUgcGFzc2VkIHByb21pc2VzLCBvclxuICByZWplY3RlZCB3aXRoIHRoZSByZWFzb24gb2YgdGhlIGZpcnN0IHBhc3NlZCBwcm9taXNlIHRvIGJlIHJlamVjdGVkLiBJdCBjYXN0cyBhbGxcbiAgZWxlbWVudHMgb2YgdGhlIHBhc3NlZCBpdGVyYWJsZSB0byBwcm9taXNlcyBhcyBpdCBydW5zIHRoaXMgYWxnb3JpdGhtLlxuXG4gIEV4YW1wbGU6XG5cbiAgYGBgamF2YXNjcmlwdFxuICBsZXQgcHJvbWlzZTEgPSByZXNvbHZlKDEpO1xuICBsZXQgcHJvbWlzZTIgPSByZXNvbHZlKDIpO1xuICBsZXQgcHJvbWlzZTMgPSByZXNvbHZlKDMpO1xuICBsZXQgcHJvbWlzZXMgPSBbIHByb21pc2UxLCBwcm9taXNlMiwgcHJvbWlzZTMgXTtcblxuICBQcm9taXNlLmFsbChwcm9taXNlcykudGhlbihmdW5jdGlvbihhcnJheSl7XG4gICAgLy8gVGhlIGFycmF5IGhlcmUgd291bGQgYmUgWyAxLCAyLCAzIF07XG4gIH0pO1xuICBgYGBcblxuICBJZiBhbnkgb2YgdGhlIGBwcm9taXNlc2AgZ2l2ZW4gdG8gYGFsbGAgYXJlIHJlamVjdGVkLCB0aGUgZmlyc3QgcHJvbWlzZVxuICB0aGF0IGlzIHJlamVjdGVkIHdpbGwgYmUgZ2l2ZW4gYXMgYW4gYXJndW1lbnQgdG8gdGhlIHJldHVybmVkIHByb21pc2VzJ3NcbiAgcmVqZWN0aW9uIGhhbmRsZXIuIEZvciBleGFtcGxlOlxuXG4gIEV4YW1wbGU6XG5cbiAgYGBgamF2YXNjcmlwdFxuICBsZXQgcHJvbWlzZTEgPSByZXNvbHZlKDEpO1xuICBsZXQgcHJvbWlzZTIgPSByZWplY3QobmV3IEVycm9yKFwiMlwiKSk7XG4gIGxldCBwcm9taXNlMyA9IHJlamVjdChuZXcgRXJyb3IoXCIzXCIpKTtcbiAgbGV0IHByb21pc2VzID0gWyBwcm9taXNlMSwgcHJvbWlzZTIsIHByb21pc2UzIF07XG5cbiAgUHJvbWlzZS5hbGwocHJvbWlzZXMpLnRoZW4oZnVuY3Rpb24oYXJyYXkpe1xuICAgIC8vIENvZGUgaGVyZSBuZXZlciBydW5zIGJlY2F1c2UgdGhlcmUgYXJlIHJlamVjdGVkIHByb21pc2VzIVxuICB9LCBmdW5jdGlvbihlcnJvcikge1xuICAgIC8vIGVycm9yLm1lc3NhZ2UgPT09IFwiMlwiXG4gIH0pO1xuICBgYGBcblxuICBAbWV0aG9kIGFsbFxuICBAc3RhdGljXG4gIEBwYXJhbSB7QXJyYXl9IGVudHJpZXMgYXJyYXkgb2YgcHJvbWlzZXNcbiAgQHBhcmFtIHtTdHJpbmd9IGxhYmVsIG9wdGlvbmFsIHN0cmluZyBmb3IgbGFiZWxpbmcgdGhlIHByb21pc2UuXG4gIFVzZWZ1bCBmb3IgdG9vbGluZy5cbiAgQHJldHVybiB7UHJvbWlzZX0gcHJvbWlzZSB0aGF0IGlzIGZ1bGZpbGxlZCB3aGVuIGFsbCBgcHJvbWlzZXNgIGhhdmUgYmVlblxuICBmdWxmaWxsZWQsIG9yIHJlamVjdGVkIGlmIGFueSBvZiB0aGVtIGJlY29tZSByZWplY3RlZC5cbiAgQHN0YXRpY1xuKi9cbmZ1bmN0aW9uIGFsbChlbnRyaWVzKSB7XG4gIHJldHVybiBuZXcgRW51bWVyYXRvcih0aGlzLCBlbnRyaWVzKS5wcm9taXNlO1xufVxuXG4vKipcbiAgYFByb21pc2UucmFjZWAgcmV0dXJucyBhIG5ldyBwcm9taXNlIHdoaWNoIGlzIHNldHRsZWQgaW4gdGhlIHNhbWUgd2F5IGFzIHRoZVxuICBmaXJzdCBwYXNzZWQgcHJvbWlzZSB0byBzZXR0bGUuXG5cbiAgRXhhbXBsZTpcblxuICBgYGBqYXZhc2NyaXB0XG4gIGxldCBwcm9taXNlMSA9IG5ldyBQcm9taXNlKGZ1bmN0aW9uKHJlc29sdmUsIHJlamVjdCl7XG4gICAgc2V0VGltZW91dChmdW5jdGlvbigpe1xuICAgICAgcmVzb2x2ZSgncHJvbWlzZSAxJyk7XG4gICAgfSwgMjAwKTtcbiAgfSk7XG5cbiAgbGV0IHByb21pc2UyID0gbmV3IFByb21pc2UoZnVuY3Rpb24ocmVzb2x2ZSwgcmVqZWN0KXtcbiAgICBzZXRUaW1lb3V0KGZ1bmN0aW9uKCl7XG4gICAgICByZXNvbHZlKCdwcm9taXNlIDInKTtcbiAgICB9LCAxMDApO1xuICB9KTtcblxuICBQcm9taXNlLnJhY2UoW3Byb21pc2UxLCBwcm9taXNlMl0pLnRoZW4oZnVuY3Rpb24ocmVzdWx0KXtcbiAgICAvLyByZXN1bHQgPT09ICdwcm9taXNlIDInIGJlY2F1c2UgaXQgd2FzIHJlc29sdmVkIGJlZm9yZSBwcm9taXNlMVxuICAgIC8vIHdhcyByZXNvbHZlZC5cbiAgfSk7XG4gIGBgYFxuXG4gIGBQcm9taXNlLnJhY2VgIGlzIGRldGVybWluaXN0aWMgaW4gdGhhdCBvbmx5IHRoZSBzdGF0ZSBvZiB0aGUgZmlyc3RcbiAgc2V0dGxlZCBwcm9taXNlIG1hdHRlcnMuIEZvciBleGFtcGxlLCBldmVuIGlmIG90aGVyIHByb21pc2VzIGdpdmVuIHRvIHRoZVxuICBgcHJvbWlzZXNgIGFycmF5IGFyZ3VtZW50IGFyZSByZXNvbHZlZCwgYnV0IHRoZSBmaXJzdCBzZXR0bGVkIHByb21pc2UgaGFzXG4gIGJlY29tZSByZWplY3RlZCBiZWZvcmUgdGhlIG90aGVyIHByb21pc2VzIGJlY2FtZSBmdWxmaWxsZWQsIHRoZSByZXR1cm5lZFxuICBwcm9taXNlIHdpbGwgYmVjb21lIHJlamVjdGVkOlxuXG4gIGBgYGphdmFzY3JpcHRcbiAgbGV0IHByb21pc2UxID0gbmV3IFByb21pc2UoZnVuY3Rpb24ocmVzb2x2ZSwgcmVqZWN0KXtcbiAgICBzZXRUaW1lb3V0KGZ1bmN0aW9uKCl7XG4gICAgICByZXNvbHZlKCdwcm9taXNlIDEnKTtcbiAgICB9LCAyMDApO1xuICB9KTtcblxuICBsZXQgcHJvbWlzZTIgPSBuZXcgUHJvbWlzZShmdW5jdGlvbihyZXNvbHZlLCByZWplY3Qpe1xuICAgIHNldFRpbWVvdXQoZnVuY3Rpb24oKXtcbiAgICAgIHJlamVjdChuZXcgRXJyb3IoJ3Byb21pc2UgMicpKTtcbiAgICB9LCAxMDApO1xuICB9KTtcblxuICBQcm9taXNlLnJhY2UoW3Byb21pc2UxLCBwcm9taXNlMl0pLnRoZW4oZnVuY3Rpb24ocmVzdWx0KXtcbiAgICAvLyBDb2RlIGhlcmUgbmV2ZXIgcnVuc1xuICB9LCBmdW5jdGlvbihyZWFzb24pe1xuICAgIC8vIHJlYXNvbi5tZXNzYWdlID09PSAncHJvbWlzZSAyJyBiZWNhdXNlIHByb21pc2UgMiBiZWNhbWUgcmVqZWN0ZWQgYmVmb3JlXG4gICAgLy8gcHJvbWlzZSAxIGJlY2FtZSBmdWxmaWxsZWRcbiAgfSk7XG4gIGBgYFxuXG4gIEFuIGV4YW1wbGUgcmVhbC13b3JsZCB1c2UgY2FzZSBpcyBpbXBsZW1lbnRpbmcgdGltZW91dHM6XG5cbiAgYGBgamF2YXNjcmlwdFxuICBQcm9taXNlLnJhY2UoW2FqYXgoJ2Zvby5qc29uJyksIHRpbWVvdXQoNTAwMCldKVxuICBgYGBcblxuICBAbWV0aG9kIHJhY2VcbiAgQHN0YXRpY1xuICBAcGFyYW0ge0FycmF5fSBwcm9taXNlcyBhcnJheSBvZiBwcm9taXNlcyB0byBvYnNlcnZlXG4gIFVzZWZ1bCBmb3IgdG9vbGluZy5cbiAgQHJldHVybiB7UHJvbWlzZX0gYSBwcm9taXNlIHdoaWNoIHNldHRsZXMgaW4gdGhlIHNhbWUgd2F5IGFzIHRoZSBmaXJzdCBwYXNzZWRcbiAgcHJvbWlzZSB0byBzZXR0bGUuXG4qL1xuZnVuY3Rpb24gcmFjZShlbnRyaWVzKSB7XG4gIC8qanNoaW50IHZhbGlkdGhpczp0cnVlICovXG4gIHZhciBDb25zdHJ1Y3RvciA9IHRoaXM7XG5cbiAgaWYgKCFpc0FycmF5KGVudHJpZXMpKSB7XG4gICAgcmV0dXJuIG5ldyBDb25zdHJ1Y3RvcihmdW5jdGlvbiAoXywgcmVqZWN0KSB7XG4gICAgICByZXR1cm4gcmVqZWN0KG5ldyBUeXBlRXJyb3IoJ1lvdSBtdXN0IHBhc3MgYW4gYXJyYXkgdG8gcmFjZS4nKSk7XG4gICAgfSk7XG4gIH0gZWxzZSB7XG4gICAgcmV0dXJuIG5ldyBDb25zdHJ1Y3RvcihmdW5jdGlvbiAocmVzb2x2ZSwgcmVqZWN0KSB7XG4gICAgICB2YXIgbGVuZ3RoID0gZW50cmllcy5sZW5ndGg7XG4gICAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxlbmd0aDsgaSsrKSB7XG4gICAgICAgIENvbnN0cnVjdG9yLnJlc29sdmUoZW50cmllc1tpXSkudGhlbihyZXNvbHZlLCByZWplY3QpO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG59XG5cbi8qKlxuICBgUHJvbWlzZS5yZWplY3RgIHJldHVybnMgYSBwcm9taXNlIHJlamVjdGVkIHdpdGggdGhlIHBhc3NlZCBgcmVhc29uYC5cbiAgSXQgaXMgc2hvcnRoYW5kIGZvciB0aGUgZm9sbG93aW5nOlxuXG4gIGBgYGphdmFzY3JpcHRcbiAgbGV0IHByb21pc2UgPSBuZXcgUHJvbWlzZShmdW5jdGlvbihyZXNvbHZlLCByZWplY3Qpe1xuICAgIHJlamVjdChuZXcgRXJyb3IoJ1dIT09QUycpKTtcbiAgfSk7XG5cbiAgcHJvbWlzZS50aGVuKGZ1bmN0aW9uKHZhbHVlKXtcbiAgICAvLyBDb2RlIGhlcmUgZG9lc24ndCBydW4gYmVjYXVzZSB0aGUgcHJvbWlzZSBpcyByZWplY3RlZCFcbiAgfSwgZnVuY3Rpb24ocmVhc29uKXtcbiAgICAvLyByZWFzb24ubWVzc2FnZSA9PT0gJ1dIT09QUydcbiAgfSk7XG4gIGBgYFxuXG4gIEluc3RlYWQgb2Ygd3JpdGluZyB0aGUgYWJvdmUsIHlvdXIgY29kZSBub3cgc2ltcGx5IGJlY29tZXMgdGhlIGZvbGxvd2luZzpcblxuICBgYGBqYXZhc2NyaXB0XG4gIGxldCBwcm9taXNlID0gUHJvbWlzZS5yZWplY3QobmV3IEVycm9yKCdXSE9PUFMnKSk7XG5cbiAgcHJvbWlzZS50aGVuKGZ1bmN0aW9uKHZhbHVlKXtcbiAgICAvLyBDb2RlIGhlcmUgZG9lc24ndCBydW4gYmVjYXVzZSB0aGUgcHJvbWlzZSBpcyByZWplY3RlZCFcbiAgfSwgZnVuY3Rpb24ocmVhc29uKXtcbiAgICAvLyByZWFzb24ubWVzc2FnZSA9PT0gJ1dIT09QUydcbiAgfSk7XG4gIGBgYFxuXG4gIEBtZXRob2QgcmVqZWN0XG4gIEBzdGF0aWNcbiAgQHBhcmFtIHtBbnl9IHJlYXNvbiB2YWx1ZSB0aGF0IHRoZSByZXR1cm5lZCBwcm9taXNlIHdpbGwgYmUgcmVqZWN0ZWQgd2l0aC5cbiAgVXNlZnVsIGZvciB0b29saW5nLlxuICBAcmV0dXJuIHtQcm9taXNlfSBhIHByb21pc2UgcmVqZWN0ZWQgd2l0aCB0aGUgZ2l2ZW4gYHJlYXNvbmAuXG4qL1xuZnVuY3Rpb24gcmVqZWN0KHJlYXNvbikge1xuICAvKmpzaGludCB2YWxpZHRoaXM6dHJ1ZSAqL1xuICB2YXIgQ29uc3RydWN0b3IgPSB0aGlzO1xuICB2YXIgcHJvbWlzZSA9IG5ldyBDb25zdHJ1Y3Rvcihub29wKTtcbiAgX3JlamVjdChwcm9taXNlLCByZWFzb24pO1xuICByZXR1cm4gcHJvbWlzZTtcbn1cblxuZnVuY3Rpb24gbmVlZHNSZXNvbHZlcigpIHtcbiAgdGhyb3cgbmV3IFR5cGVFcnJvcignWW91IG11c3QgcGFzcyBhIHJlc29sdmVyIGZ1bmN0aW9uIGFzIHRoZSBmaXJzdCBhcmd1bWVudCB0byB0aGUgcHJvbWlzZSBjb25zdHJ1Y3RvcicpO1xufVxuXG5mdW5jdGlvbiBuZWVkc05ldygpIHtcbiAgdGhyb3cgbmV3IFR5cGVFcnJvcihcIkZhaWxlZCB0byBjb25zdHJ1Y3QgJ1Byb21pc2UnOiBQbGVhc2UgdXNlIHRoZSAnbmV3JyBvcGVyYXRvciwgdGhpcyBvYmplY3QgY29uc3RydWN0b3IgY2Fubm90IGJlIGNhbGxlZCBhcyBhIGZ1bmN0aW9uLlwiKTtcbn1cblxuLyoqXG4gIFByb21pc2Ugb2JqZWN0cyByZXByZXNlbnQgdGhlIGV2ZW50dWFsIHJlc3VsdCBvZiBhbiBhc3luY2hyb25vdXMgb3BlcmF0aW9uLiBUaGVcbiAgcHJpbWFyeSB3YXkgb2YgaW50ZXJhY3Rpbmcgd2l0aCBhIHByb21pc2UgaXMgdGhyb3VnaCBpdHMgYHRoZW5gIG1ldGhvZCwgd2hpY2hcbiAgcmVnaXN0ZXJzIGNhbGxiYWNrcyB0byByZWNlaXZlIGVpdGhlciBhIHByb21pc2UncyBldmVudHVhbCB2YWx1ZSBvciB0aGUgcmVhc29uXG4gIHdoeSB0aGUgcHJvbWlzZSBjYW5ub3QgYmUgZnVsZmlsbGVkLlxuXG4gIFRlcm1pbm9sb2d5XG4gIC0tLS0tLS0tLS0tXG5cbiAgLSBgcHJvbWlzZWAgaXMgYW4gb2JqZWN0IG9yIGZ1bmN0aW9uIHdpdGggYSBgdGhlbmAgbWV0aG9kIHdob3NlIGJlaGF2aW9yIGNvbmZvcm1zIHRvIHRoaXMgc3BlY2lmaWNhdGlvbi5cbiAgLSBgdGhlbmFibGVgIGlzIGFuIG9iamVjdCBvciBmdW5jdGlvbiB0aGF0IGRlZmluZXMgYSBgdGhlbmAgbWV0aG9kLlxuICAtIGB2YWx1ZWAgaXMgYW55IGxlZ2FsIEphdmFTY3JpcHQgdmFsdWUgKGluY2x1ZGluZyB1bmRlZmluZWQsIGEgdGhlbmFibGUsIG9yIGEgcHJvbWlzZSkuXG4gIC0gYGV4Y2VwdGlvbmAgaXMgYSB2YWx1ZSB0aGF0IGlzIHRocm93biB1c2luZyB0aGUgdGhyb3cgc3RhdGVtZW50LlxuICAtIGByZWFzb25gIGlzIGEgdmFsdWUgdGhhdCBpbmRpY2F0ZXMgd2h5IGEgcHJvbWlzZSB3YXMgcmVqZWN0ZWQuXG4gIC0gYHNldHRsZWRgIHRoZSBmaW5hbCByZXN0aW5nIHN0YXRlIG9mIGEgcHJvbWlzZSwgZnVsZmlsbGVkIG9yIHJlamVjdGVkLlxuXG4gIEEgcHJvbWlzZSBjYW4gYmUgaW4gb25lIG9mIHRocmVlIHN0YXRlczogcGVuZGluZywgZnVsZmlsbGVkLCBvciByZWplY3RlZC5cblxuICBQcm9taXNlcyB0aGF0IGFyZSBmdWxmaWxsZWQgaGF2ZSBhIGZ1bGZpbGxtZW50IHZhbHVlIGFuZCBhcmUgaW4gdGhlIGZ1bGZpbGxlZFxuICBzdGF0ZS4gIFByb21pc2VzIHRoYXQgYXJlIHJlamVjdGVkIGhhdmUgYSByZWplY3Rpb24gcmVhc29uIGFuZCBhcmUgaW4gdGhlXG4gIHJlamVjdGVkIHN0YXRlLiAgQSBmdWxmaWxsbWVudCB2YWx1ZSBpcyBuZXZlciBhIHRoZW5hYmxlLlxuXG4gIFByb21pc2VzIGNhbiBhbHNvIGJlIHNhaWQgdG8gKnJlc29sdmUqIGEgdmFsdWUuICBJZiB0aGlzIHZhbHVlIGlzIGFsc28gYVxuICBwcm9taXNlLCB0aGVuIHRoZSBvcmlnaW5hbCBwcm9taXNlJ3Mgc2V0dGxlZCBzdGF0ZSB3aWxsIG1hdGNoIHRoZSB2YWx1ZSdzXG4gIHNldHRsZWQgc3RhdGUuICBTbyBhIHByb21pc2UgdGhhdCAqcmVzb2x2ZXMqIGEgcHJvbWlzZSB0aGF0IHJlamVjdHMgd2lsbFxuICBpdHNlbGYgcmVqZWN0LCBhbmQgYSBwcm9taXNlIHRoYXQgKnJlc29sdmVzKiBhIHByb21pc2UgdGhhdCBmdWxmaWxscyB3aWxsXG4gIGl0c2VsZiBmdWxmaWxsLlxuXG5cbiAgQmFzaWMgVXNhZ2U6XG4gIC0tLS0tLS0tLS0tLVxuXG4gIGBgYGpzXG4gIGxldCBwcm9taXNlID0gbmV3IFByb21pc2UoZnVuY3Rpb24ocmVzb2x2ZSwgcmVqZWN0KSB7XG4gICAgLy8gb24gc3VjY2Vzc1xuICAgIHJlc29sdmUodmFsdWUpO1xuXG4gICAgLy8gb24gZmFpbHVyZVxuICAgIHJlamVjdChyZWFzb24pO1xuICB9KTtcblxuICBwcm9taXNlLnRoZW4oZnVuY3Rpb24odmFsdWUpIHtcbiAgICAvLyBvbiBmdWxmaWxsbWVudFxuICB9LCBmdW5jdGlvbihyZWFzb24pIHtcbiAgICAvLyBvbiByZWplY3Rpb25cbiAgfSk7XG4gIGBgYFxuXG4gIEFkdmFuY2VkIFVzYWdlOlxuICAtLS0tLS0tLS0tLS0tLS1cblxuICBQcm9taXNlcyBzaGluZSB3aGVuIGFic3RyYWN0aW5nIGF3YXkgYXN5bmNocm9ub3VzIGludGVyYWN0aW9ucyBzdWNoIGFzXG4gIGBYTUxIdHRwUmVxdWVzdGBzLlxuXG4gIGBgYGpzXG4gIGZ1bmN0aW9uIGdldEpTT04odXJsKSB7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKGZ1bmN0aW9uKHJlc29sdmUsIHJlamVjdCl7XG4gICAgICBsZXQgeGhyID0gbmV3IFhNTEh0dHBSZXF1ZXN0KCk7XG5cbiAgICAgIHhoci5vcGVuKCdHRVQnLCB1cmwpO1xuICAgICAgeGhyLm9ucmVhZHlzdGF0ZWNoYW5nZSA9IGhhbmRsZXI7XG4gICAgICB4aHIucmVzcG9uc2VUeXBlID0gJ2pzb24nO1xuICAgICAgeGhyLnNldFJlcXVlc3RIZWFkZXIoJ0FjY2VwdCcsICdhcHBsaWNhdGlvbi9qc29uJyk7XG4gICAgICB4aHIuc2VuZCgpO1xuXG4gICAgICBmdW5jdGlvbiBoYW5kbGVyKCkge1xuICAgICAgICBpZiAodGhpcy5yZWFkeVN0YXRlID09PSB0aGlzLkRPTkUpIHtcbiAgICAgICAgICBpZiAodGhpcy5zdGF0dXMgPT09IDIwMCkge1xuICAgICAgICAgICAgcmVzb2x2ZSh0aGlzLnJlc3BvbnNlKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcmVqZWN0KG5ldyBFcnJvcignZ2V0SlNPTjogYCcgKyB1cmwgKyAnYCBmYWlsZWQgd2l0aCBzdGF0dXM6IFsnICsgdGhpcy5zdGF0dXMgKyAnXScpKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH07XG4gICAgfSk7XG4gIH1cblxuICBnZXRKU09OKCcvcG9zdHMuanNvbicpLnRoZW4oZnVuY3Rpb24oanNvbikge1xuICAgIC8vIG9uIGZ1bGZpbGxtZW50XG4gIH0sIGZ1bmN0aW9uKHJlYXNvbikge1xuICAgIC8vIG9uIHJlamVjdGlvblxuICB9KTtcbiAgYGBgXG5cbiAgVW5saWtlIGNhbGxiYWNrcywgcHJvbWlzZXMgYXJlIGdyZWF0IGNvbXBvc2FibGUgcHJpbWl0aXZlcy5cblxuICBgYGBqc1xuICBQcm9taXNlLmFsbChbXG4gICAgZ2V0SlNPTignL3Bvc3RzJyksXG4gICAgZ2V0SlNPTignL2NvbW1lbnRzJylcbiAgXSkudGhlbihmdW5jdGlvbih2YWx1ZXMpe1xuICAgIHZhbHVlc1swXSAvLyA9PiBwb3N0c0pTT05cbiAgICB2YWx1ZXNbMV0gLy8gPT4gY29tbWVudHNKU09OXG5cbiAgICByZXR1cm4gdmFsdWVzO1xuICB9KTtcbiAgYGBgXG5cbiAgQGNsYXNzIFByb21pc2VcbiAgQHBhcmFtIHtmdW5jdGlvbn0gcmVzb2x2ZXJcbiAgVXNlZnVsIGZvciB0b29saW5nLlxuICBAY29uc3RydWN0b3JcbiovXG5mdW5jdGlvbiBQcm9taXNlKHJlc29sdmVyKSB7XG4gIHRoaXNbUFJPTUlTRV9JRF0gPSBuZXh0SWQoKTtcbiAgdGhpcy5fcmVzdWx0ID0gdGhpcy5fc3RhdGUgPSB1bmRlZmluZWQ7XG4gIHRoaXMuX3N1YnNjcmliZXJzID0gW107XG5cbiAgaWYgKG5vb3AgIT09IHJlc29sdmVyKSB7XG4gICAgdHlwZW9mIHJlc29sdmVyICE9PSAnZnVuY3Rpb24nICYmIG5lZWRzUmVzb2x2ZXIoKTtcbiAgICB0aGlzIGluc3RhbmNlb2YgUHJvbWlzZSA/IGluaXRpYWxpemVQcm9taXNlKHRoaXMsIHJlc29sdmVyKSA6IG5lZWRzTmV3KCk7XG4gIH1cbn1cblxuUHJvbWlzZS5hbGwgPSBhbGw7XG5Qcm9taXNlLnJhY2UgPSByYWNlO1xuUHJvbWlzZS5yZXNvbHZlID0gcmVzb2x2ZTtcblByb21pc2UucmVqZWN0ID0gcmVqZWN0O1xuUHJvbWlzZS5fc2V0U2NoZWR1bGVyID0gc2V0U2NoZWR1bGVyO1xuUHJvbWlzZS5fc2V0QXNhcCA9IHNldEFzYXA7XG5Qcm9taXNlLl9hc2FwID0gYXNhcDtcblxuUHJvbWlzZS5wcm90b3R5cGUgPSB7XG4gIGNvbnN0cnVjdG9yOiBQcm9taXNlLFxuXG4gIC8qKlxuICAgIFRoZSBwcmltYXJ5IHdheSBvZiBpbnRlcmFjdGluZyB3aXRoIGEgcHJvbWlzZSBpcyB0aHJvdWdoIGl0cyBgdGhlbmAgbWV0aG9kLFxuICAgIHdoaWNoIHJlZ2lzdGVycyBjYWxsYmFja3MgdG8gcmVjZWl2ZSBlaXRoZXIgYSBwcm9taXNlJ3MgZXZlbnR1YWwgdmFsdWUgb3IgdGhlXG4gICAgcmVhc29uIHdoeSB0aGUgcHJvbWlzZSBjYW5ub3QgYmUgZnVsZmlsbGVkLlxuICBcbiAgICBgYGBqc1xuICAgIGZpbmRVc2VyKCkudGhlbihmdW5jdGlvbih1c2VyKXtcbiAgICAgIC8vIHVzZXIgaXMgYXZhaWxhYmxlXG4gICAgfSwgZnVuY3Rpb24ocmVhc29uKXtcbiAgICAgIC8vIHVzZXIgaXMgdW5hdmFpbGFibGUsIGFuZCB5b3UgYXJlIGdpdmVuIHRoZSByZWFzb24gd2h5XG4gICAgfSk7XG4gICAgYGBgXG4gIFxuICAgIENoYWluaW5nXG4gICAgLS0tLS0tLS1cbiAgXG4gICAgVGhlIHJldHVybiB2YWx1ZSBvZiBgdGhlbmAgaXMgaXRzZWxmIGEgcHJvbWlzZS4gIFRoaXMgc2Vjb25kLCAnZG93bnN0cmVhbSdcbiAgICBwcm9taXNlIGlzIHJlc29sdmVkIHdpdGggdGhlIHJldHVybiB2YWx1ZSBvZiB0aGUgZmlyc3QgcHJvbWlzZSdzIGZ1bGZpbGxtZW50XG4gICAgb3IgcmVqZWN0aW9uIGhhbmRsZXIsIG9yIHJlamVjdGVkIGlmIHRoZSBoYW5kbGVyIHRocm93cyBhbiBleGNlcHRpb24uXG4gIFxuICAgIGBgYGpzXG4gICAgZmluZFVzZXIoKS50aGVuKGZ1bmN0aW9uICh1c2VyKSB7XG4gICAgICByZXR1cm4gdXNlci5uYW1lO1xuICAgIH0sIGZ1bmN0aW9uIChyZWFzb24pIHtcbiAgICAgIHJldHVybiAnZGVmYXVsdCBuYW1lJztcbiAgICB9KS50aGVuKGZ1bmN0aW9uICh1c2VyTmFtZSkge1xuICAgICAgLy8gSWYgYGZpbmRVc2VyYCBmdWxmaWxsZWQsIGB1c2VyTmFtZWAgd2lsbCBiZSB0aGUgdXNlcidzIG5hbWUsIG90aGVyd2lzZSBpdFxuICAgICAgLy8gd2lsbCBiZSBgJ2RlZmF1bHQgbmFtZSdgXG4gICAgfSk7XG4gIFxuICAgIGZpbmRVc2VyKCkudGhlbihmdW5jdGlvbiAodXNlcikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdGb3VuZCB1c2VyLCBidXQgc3RpbGwgdW5oYXBweScpO1xuICAgIH0sIGZ1bmN0aW9uIChyZWFzb24pIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignYGZpbmRVc2VyYCByZWplY3RlZCBhbmQgd2UncmUgdW5oYXBweScpO1xuICAgIH0pLnRoZW4oZnVuY3Rpb24gKHZhbHVlKSB7XG4gICAgICAvLyBuZXZlciByZWFjaGVkXG4gICAgfSwgZnVuY3Rpb24gKHJlYXNvbikge1xuICAgICAgLy8gaWYgYGZpbmRVc2VyYCBmdWxmaWxsZWQsIGByZWFzb25gIHdpbGwgYmUgJ0ZvdW5kIHVzZXIsIGJ1dCBzdGlsbCB1bmhhcHB5Jy5cbiAgICAgIC8vIElmIGBmaW5kVXNlcmAgcmVqZWN0ZWQsIGByZWFzb25gIHdpbGwgYmUgJ2BmaW5kVXNlcmAgcmVqZWN0ZWQgYW5kIHdlJ3JlIHVuaGFwcHknLlxuICAgIH0pO1xuICAgIGBgYFxuICAgIElmIHRoZSBkb3duc3RyZWFtIHByb21pc2UgZG9lcyBub3Qgc3BlY2lmeSBhIHJlamVjdGlvbiBoYW5kbGVyLCByZWplY3Rpb24gcmVhc29ucyB3aWxsIGJlIHByb3BhZ2F0ZWQgZnVydGhlciBkb3duc3RyZWFtLlxuICBcbiAgICBgYGBqc1xuICAgIGZpbmRVc2VyKCkudGhlbihmdW5jdGlvbiAodXNlcikge1xuICAgICAgdGhyb3cgbmV3IFBlZGFnb2dpY2FsRXhjZXB0aW9uKCdVcHN0cmVhbSBlcnJvcicpO1xuICAgIH0pLnRoZW4oZnVuY3Rpb24gKHZhbHVlKSB7XG4gICAgICAvLyBuZXZlciByZWFjaGVkXG4gICAgfSkudGhlbihmdW5jdGlvbiAodmFsdWUpIHtcbiAgICAgIC8vIG5ldmVyIHJlYWNoZWRcbiAgICB9LCBmdW5jdGlvbiAocmVhc29uKSB7XG4gICAgICAvLyBUaGUgYFBlZGdhZ29jaWFsRXhjZXB0aW9uYCBpcyBwcm9wYWdhdGVkIGFsbCB0aGUgd2F5IGRvd24gdG8gaGVyZVxuICAgIH0pO1xuICAgIGBgYFxuICBcbiAgICBBc3NpbWlsYXRpb25cbiAgICAtLS0tLS0tLS0tLS1cbiAgXG4gICAgU29tZXRpbWVzIHRoZSB2YWx1ZSB5b3Ugd2FudCB0byBwcm9wYWdhdGUgdG8gYSBkb3duc3RyZWFtIHByb21pc2UgY2FuIG9ubHkgYmVcbiAgICByZXRyaWV2ZWQgYXN5bmNocm9ub3VzbHkuIFRoaXMgY2FuIGJlIGFjaGlldmVkIGJ5IHJldHVybmluZyBhIHByb21pc2UgaW4gdGhlXG4gICAgZnVsZmlsbG1lbnQgb3IgcmVqZWN0aW9uIGhhbmRsZXIuIFRoZSBkb3duc3RyZWFtIHByb21pc2Ugd2lsbCB0aGVuIGJlIHBlbmRpbmdcbiAgICB1bnRpbCB0aGUgcmV0dXJuZWQgcHJvbWlzZSBpcyBzZXR0bGVkLiBUaGlzIGlzIGNhbGxlZCAqYXNzaW1pbGF0aW9uKi5cbiAgXG4gICAgYGBganNcbiAgICBmaW5kVXNlcigpLnRoZW4oZnVuY3Rpb24gKHVzZXIpIHtcbiAgICAgIHJldHVybiBmaW5kQ29tbWVudHNCeUF1dGhvcih1c2VyKTtcbiAgICB9KS50aGVuKGZ1bmN0aW9uIChjb21tZW50cykge1xuICAgICAgLy8gVGhlIHVzZXIncyBjb21tZW50cyBhcmUgbm93IGF2YWlsYWJsZVxuICAgIH0pO1xuICAgIGBgYFxuICBcbiAgICBJZiB0aGUgYXNzaW1saWF0ZWQgcHJvbWlzZSByZWplY3RzLCB0aGVuIHRoZSBkb3duc3RyZWFtIHByb21pc2Ugd2lsbCBhbHNvIHJlamVjdC5cbiAgXG4gICAgYGBganNcbiAgICBmaW5kVXNlcigpLnRoZW4oZnVuY3Rpb24gKHVzZXIpIHtcbiAgICAgIHJldHVybiBmaW5kQ29tbWVudHNCeUF1dGhvcih1c2VyKTtcbiAgICB9KS50aGVuKGZ1bmN0aW9uIChjb21tZW50cykge1xuICAgICAgLy8gSWYgYGZpbmRDb21tZW50c0J5QXV0aG9yYCBmdWxmaWxscywgd2UnbGwgaGF2ZSB0aGUgdmFsdWUgaGVyZVxuICAgIH0sIGZ1bmN0aW9uIChyZWFzb24pIHtcbiAgICAgIC8vIElmIGBmaW5kQ29tbWVudHNCeUF1dGhvcmAgcmVqZWN0cywgd2UnbGwgaGF2ZSB0aGUgcmVhc29uIGhlcmVcbiAgICB9KTtcbiAgICBgYGBcbiAgXG4gICAgU2ltcGxlIEV4YW1wbGVcbiAgICAtLS0tLS0tLS0tLS0tLVxuICBcbiAgICBTeW5jaHJvbm91cyBFeGFtcGxlXG4gIFxuICAgIGBgYGphdmFzY3JpcHRcbiAgICBsZXQgcmVzdWx0O1xuICBcbiAgICB0cnkge1xuICAgICAgcmVzdWx0ID0gZmluZFJlc3VsdCgpO1xuICAgICAgLy8gc3VjY2Vzc1xuICAgIH0gY2F0Y2gocmVhc29uKSB7XG4gICAgICAvLyBmYWlsdXJlXG4gICAgfVxuICAgIGBgYFxuICBcbiAgICBFcnJiYWNrIEV4YW1wbGVcbiAgXG4gICAgYGBganNcbiAgICBmaW5kUmVzdWx0KGZ1bmN0aW9uKHJlc3VsdCwgZXJyKXtcbiAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgLy8gZmFpbHVyZVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gc3VjY2Vzc1xuICAgICAgfVxuICAgIH0pO1xuICAgIGBgYFxuICBcbiAgICBQcm9taXNlIEV4YW1wbGU7XG4gIFxuICAgIGBgYGphdmFzY3JpcHRcbiAgICBmaW5kUmVzdWx0KCkudGhlbihmdW5jdGlvbihyZXN1bHQpe1xuICAgICAgLy8gc3VjY2Vzc1xuICAgIH0sIGZ1bmN0aW9uKHJlYXNvbil7XG4gICAgICAvLyBmYWlsdXJlXG4gICAgfSk7XG4gICAgYGBgXG4gIFxuICAgIEFkdmFuY2VkIEV4YW1wbGVcbiAgICAtLS0tLS0tLS0tLS0tLVxuICBcbiAgICBTeW5jaHJvbm91cyBFeGFtcGxlXG4gIFxuICAgIGBgYGphdmFzY3JpcHRcbiAgICBsZXQgYXV0aG9yLCBib29rcztcbiAgXG4gICAgdHJ5IHtcbiAgICAgIGF1dGhvciA9IGZpbmRBdXRob3IoKTtcbiAgICAgIGJvb2tzICA9IGZpbmRCb29rc0J5QXV0aG9yKGF1dGhvcik7XG4gICAgICAvLyBzdWNjZXNzXG4gICAgfSBjYXRjaChyZWFzb24pIHtcbiAgICAgIC8vIGZhaWx1cmVcbiAgICB9XG4gICAgYGBgXG4gIFxuICAgIEVycmJhY2sgRXhhbXBsZVxuICBcbiAgICBgYGBqc1xuICBcbiAgICBmdW5jdGlvbiBmb3VuZEJvb2tzKGJvb2tzKSB7XG4gIFxuICAgIH1cbiAgXG4gICAgZnVuY3Rpb24gZmFpbHVyZShyZWFzb24pIHtcbiAgXG4gICAgfVxuICBcbiAgICBmaW5kQXV0aG9yKGZ1bmN0aW9uKGF1dGhvciwgZXJyKXtcbiAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgZmFpbHVyZShlcnIpO1xuICAgICAgICAvLyBmYWlsdXJlXG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGZpbmRCb29va3NCeUF1dGhvcihhdXRob3IsIGZ1bmN0aW9uKGJvb2tzLCBlcnIpIHtcbiAgICAgICAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgICAgICAgZmFpbHVyZShlcnIpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBmb3VuZEJvb2tzKGJvb2tzKTtcbiAgICAgICAgICAgICAgfSBjYXRjaChyZWFzb24pIHtcbiAgICAgICAgICAgICAgICBmYWlsdXJlKHJlYXNvbik7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9KTtcbiAgICAgICAgfSBjYXRjaChlcnJvcikge1xuICAgICAgICAgIGZhaWx1cmUoZXJyKTtcbiAgICAgICAgfVxuICAgICAgICAvLyBzdWNjZXNzXG4gICAgICB9XG4gICAgfSk7XG4gICAgYGBgXG4gIFxuICAgIFByb21pc2UgRXhhbXBsZTtcbiAgXG4gICAgYGBgamF2YXNjcmlwdFxuICAgIGZpbmRBdXRob3IoKS5cbiAgICAgIHRoZW4oZmluZEJvb2tzQnlBdXRob3IpLlxuICAgICAgdGhlbihmdW5jdGlvbihib29rcyl7XG4gICAgICAgIC8vIGZvdW5kIGJvb2tzXG4gICAgfSkuY2F0Y2goZnVuY3Rpb24ocmVhc29uKXtcbiAgICAgIC8vIHNvbWV0aGluZyB3ZW50IHdyb25nXG4gICAgfSk7XG4gICAgYGBgXG4gIFxuICAgIEBtZXRob2QgdGhlblxuICAgIEBwYXJhbSB7RnVuY3Rpb259IG9uRnVsZmlsbGVkXG4gICAgQHBhcmFtIHtGdW5jdGlvbn0gb25SZWplY3RlZFxuICAgIFVzZWZ1bCBmb3IgdG9vbGluZy5cbiAgICBAcmV0dXJuIHtQcm9taXNlfVxuICAqL1xuICB0aGVuOiB0aGVuLFxuXG4gIC8qKlxuICAgIGBjYXRjaGAgaXMgc2ltcGx5IHN1Z2FyIGZvciBgdGhlbih1bmRlZmluZWQsIG9uUmVqZWN0aW9uKWAgd2hpY2ggbWFrZXMgaXQgdGhlIHNhbWVcbiAgICBhcyB0aGUgY2F0Y2ggYmxvY2sgb2YgYSB0cnkvY2F0Y2ggc3RhdGVtZW50LlxuICBcbiAgICBgYGBqc1xuICAgIGZ1bmN0aW9uIGZpbmRBdXRob3IoKXtcbiAgICAgIHRocm93IG5ldyBFcnJvcignY291bGRuJ3QgZmluZCB0aGF0IGF1dGhvcicpO1xuICAgIH1cbiAgXG4gICAgLy8gc3luY2hyb25vdXNcbiAgICB0cnkge1xuICAgICAgZmluZEF1dGhvcigpO1xuICAgIH0gY2F0Y2gocmVhc29uKSB7XG4gICAgICAvLyBzb21ldGhpbmcgd2VudCB3cm9uZ1xuICAgIH1cbiAgXG4gICAgLy8gYXN5bmMgd2l0aCBwcm9taXNlc1xuICAgIGZpbmRBdXRob3IoKS5jYXRjaChmdW5jdGlvbihyZWFzb24pe1xuICAgICAgLy8gc29tZXRoaW5nIHdlbnQgd3JvbmdcbiAgICB9KTtcbiAgICBgYGBcbiAgXG4gICAgQG1ldGhvZCBjYXRjaFxuICAgIEBwYXJhbSB7RnVuY3Rpb259IG9uUmVqZWN0aW9uXG4gICAgVXNlZnVsIGZvciB0b29saW5nLlxuICAgIEByZXR1cm4ge1Byb21pc2V9XG4gICovXG4gICdjYXRjaCc6IGZ1bmN0aW9uIF9jYXRjaChvblJlamVjdGlvbikge1xuICAgIHJldHVybiB0aGlzLnRoZW4obnVsbCwgb25SZWplY3Rpb24pO1xuICB9XG59O1xuXG5mdW5jdGlvbiBwb2x5ZmlsbCgpIHtcbiAgICB2YXIgbG9jYWwgPSB1bmRlZmluZWQ7XG5cbiAgICBpZiAodHlwZW9mIGdsb2JhbCAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgICAgbG9jYWwgPSBnbG9iYWw7XG4gICAgfSBlbHNlIGlmICh0eXBlb2Ygc2VsZiAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgICAgbG9jYWwgPSBzZWxmO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBsb2NhbCA9IEZ1bmN0aW9uKCdyZXR1cm4gdGhpcycpKCk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigncG9seWZpbGwgZmFpbGVkIGJlY2F1c2UgZ2xvYmFsIG9iamVjdCBpcyB1bmF2YWlsYWJsZSBpbiB0aGlzIGVudmlyb25tZW50Jyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICB2YXIgUCA9IGxvY2FsLlByb21pc2U7XG5cbiAgICBpZiAoUCkge1xuICAgICAgICB2YXIgcHJvbWlzZVRvU3RyaW5nID0gbnVsbDtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIHByb21pc2VUb1N0cmluZyA9IE9iamVjdC5wcm90b3R5cGUudG9TdHJpbmcuY2FsbChQLnJlc29sdmUoKSk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIC8vIHNpbGVudGx5IGlnbm9yZWRcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChwcm9taXNlVG9TdHJpbmcgPT09ICdbb2JqZWN0IFByb21pc2VdJyAmJiAhUC5jYXN0KSB7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBsb2NhbC5Qcm9taXNlID0gUHJvbWlzZTtcbn1cblxucG9seWZpbGwoKTtcbi8vIFN0cmFuZ2UgY29tcGF0Li5cblByb21pc2UucG9seWZpbGwgPSBwb2x5ZmlsbDtcblByb21pc2UuUHJvbWlzZSA9IFByb21pc2U7XG5cbnJldHVybiBQcm9taXNlO1xuXG59KSkpO1xuLy8jIHNvdXJjZU1hcHBpbmdVUkw9ZXM2LXByb21pc2UubWFwIiwidmFyIHJlRGVsaW0gPSAvW1xcLlxcOl0vO1xuXG4vKipcbiAgIyBtYnVzXG5cbiAgSWYgTm9kZSdzIEV2ZW50RW1pdHRlciBhbmQgRXZlIHdlcmUgdG8gaGF2ZSBhIGNoaWxkLCBpdCBtaWdodCBsb29rIHNvbWV0aGluZyBsaWtlIHRoaXMuXG4gIE5vIHdpbGRjYXJkIHN1cHBvcnQgYXQgdGhpcyBzdGFnZSB0aG91Z2guLi5cblxuICAjIyBFeGFtcGxlIFVzYWdlXG5cbiAgPDw8IGRvY3MvdXNhZ2UubWRcblxuICAjIyBSZWZlcmVuY2VcblxuICAjIyMgYG1idXMobmFtZXNwYWNlPywgcGFyZW50Pywgc2NvcGU/KWBcblxuICBDcmVhdGUgYSBuZXcgbWVzc2FnZSBidXMgd2l0aCBgbmFtZXNwYWNlYCBpbmhlcml0aW5nIGZyb20gdGhlIGBwYXJlbnRgXG4gIG1idXMgaW5zdGFuY2UuICBJZiBldmVudHMgZnJvbSB0aGlzIG1lc3NhZ2UgYnVzIHNob3VsZCBiZSB0cmlnZ2VyZWQgd2l0aFxuICBhIHNwZWNpZmljIGB0aGlzYCBzY29wZSwgdGhlbiBzcGVjaWZ5IGl0IHVzaW5nIHRoZSBgc2NvcGVgIGFyZ3VtZW50LlxuXG4qKi9cblxudmFyIGNyZWF0ZUJ1cyA9IG1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24obmFtZXNwYWNlLCBwYXJlbnQsIHNjb3BlKSB7XG4gIHZhciByZWdpc3RyeSA9IHt9O1xuICB2YXIgZmVlZHMgPSBbXTtcblxuICBmdW5jdGlvbiBidXMobmFtZSkge1xuICAgIHZhciBhcmdzID0gW10uc2xpY2UuY2FsbChhcmd1bWVudHMsIDEpO1xuICAgIHZhciBkZWxpbWl0ZWQgPSBub3JtYWxpemUobmFtZSk7XG4gICAgdmFyIGhhbmRsZXJzID0gcmVnaXN0cnlbZGVsaW1pdGVkXSB8fCBbXTtcbiAgICB2YXIgcmVzdWx0cztcblxuICAgIC8vIHNlbmQgdGhyb3VnaCB0aGUgZmVlZHNcbiAgICBmZWVkcy5mb3JFYWNoKGZ1bmN0aW9uKGZlZWQpIHtcbiAgICAgIGZlZWQoeyBuYW1lOiBkZWxpbWl0ZWQsIGFyZ3M6IGFyZ3MgfSk7XG4gICAgfSk7XG5cbiAgICAvLyBydW4gdGhlIHJlZ2lzdGVyZWQgaGFuZGxlcnNcbiAgICByZXN1bHRzID0gW10uY29uY2F0KGhhbmRsZXJzKS5tYXAoZnVuY3Rpb24oaGFuZGxlcikge1xuICAgICAgcmV0dXJuIGhhbmRsZXIuYXBwbHkoc2NvcGUgfHwgdGhpcywgYXJncyk7XG4gICAgfSk7XG5cbiAgICAvLyBydW4gdGhlIHBhcmVudCBoYW5kbGVyc1xuICAgIGlmIChidXMucGFyZW50KSB7XG4gICAgICByZXN1bHRzID0gcmVzdWx0cy5jb25jYXQoXG4gICAgICAgIGJ1cy5wYXJlbnQuYXBwbHkoXG4gICAgICAgICAgc2NvcGUgfHwgdGhpcyxcbiAgICAgICAgICBbKG5hbWVzcGFjZSA/IG5hbWVzcGFjZSArICcuJyA6ICcnKSArIGRlbGltaXRlZF0uY29uY2F0KGFyZ3MpXG4gICAgICAgIClcbiAgICAgICk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHJlc3VsdHM7XG4gIH1cblxuICAvKipcbiAgICAjIyMgYG1idXMjY2xlYXIoKWBcblxuICAgIFJlc2V0IHRoZSBoYW5kbGVyIHJlZ2lzdHJ5LCB3aGljaCBlc3NlbnRpYWwgZGVyZWdpc3RlcnMgYWxsIGV2ZW50IGxpc3RlbmVycy5cblxuICAgIF9BbGlhczpfIGByZW1vdmVBbGxMaXN0ZW5lcnNgXG4gICoqL1xuICBmdW5jdGlvbiBjbGVhcihuYW1lKSB7XG4gICAgLy8gaWYgd2UgaGF2ZSBhIG5hbWUsIHJlc2V0IGhhbmRsZXJzIGZvciB0aGF0IGhhbmRsZXJcbiAgICBpZiAobmFtZSkge1xuICAgICAgZGVsZXRlIHJlZ2lzdHJ5W25vcm1hbGl6ZShuYW1lKV07XG4gICAgfVxuICAgIC8vIG90aGVyd2lzZSwgcmVzZXQgdGhlIGVudGlyZSBoYW5kbGVyIHJlZ2lzdHJ5XG4gICAgZWxzZSB7XG4gICAgICByZWdpc3RyeSA9IHt9O1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgICMjIyBgbWJ1cyNmZWVkKGhhbmRsZXIpYFxuXG4gICAgQXR0YWNoIGEgaGFuZGxlciBmdW5jdGlvbiB0aGF0IHdpbGwgc2VlIGFsbCBldmVudHMgdGhhdCBhcmUgc2VudCB0aHJvdWdoXG4gICAgdGhpcyBidXMgaW4gYW4gXCJvYmplY3Qgc3RyZWFtXCIgZm9ybWF0IHRoYXQgbWF0Y2hlcyB0aGUgZm9sbG93aW5nIGZvcm1hdDpcblxuICAgIGBgYFxuICAgIHsgbmFtZTogJ2V2ZW50Lm5hbWUnLCBhcmdzOiBbICdldmVudCcsICdhcmdzJyBdIH1cbiAgICBgYGBcblxuICAgIFRoZSBmZWVkIGZ1bmN0aW9uIHJldHVybnMgYSBmdW5jdGlvbiB0aGF0IGNhbiBiZSBjYWxsZWQgdG8gc3RvcCB0aGUgZmVlZFxuICAgIHNlbmRpbmcgZGF0YS5cblxuICAqKi9cbiAgZnVuY3Rpb24gZmVlZChoYW5kbGVyKSB7XG4gICAgZnVuY3Rpb24gc3RvcCgpIHtcbiAgICAgIGZlZWRzLnNwbGljZShmZWVkcy5pbmRleE9mKGhhbmRsZXIpLCAxKTtcbiAgICB9XG5cbiAgICBmZWVkcy5wdXNoKGhhbmRsZXIpO1xuICAgIHJldHVybiBzdG9wO1xuICB9XG5cbiAgZnVuY3Rpb24gbm9ybWFsaXplKG5hbWUpIHtcbiAgICByZXR1cm4gKEFycmF5LmlzQXJyYXkobmFtZSkgPyBuYW1lIDogbmFtZS5zcGxpdChyZURlbGltKSkuam9pbignLicpO1xuICB9XG5cbiAgLyoqXG4gICAgIyMjIGBtYnVzI29mZihuYW1lLCBoYW5kbGVyKWBcblxuICAgIERlcmVnaXN0ZXIgYW4gZXZlbnQgaGFuZGxlci5cbiAgKiovXG4gIGZ1bmN0aW9uIG9mZihuYW1lLCBoYW5kbGVyKSB7XG4gICAgdmFyIGhhbmRsZXJzID0gcmVnaXN0cnlbbm9ybWFsaXplKG5hbWUpXSB8fCBbXTtcbiAgICB2YXIgaWR4ID0gaGFuZGxlcnMgPyBoYW5kbGVycy5pbmRleE9mKGhhbmRsZXIuX2FjdHVhbCB8fCBoYW5kbGVyKSA6IC0xO1xuXG4gICAgaWYgKGlkeCA+PSAwKSB7XG4gICAgICBoYW5kbGVycy5zcGxpY2UoaWR4LCAxKTtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICAjIyMgYG1idXMjb24obmFtZSwgaGFuZGxlcilgXG5cbiAgICBSZWdpc3RlciBhbiBldmVudCBoYW5kbGVyIGZvciB0aGUgZXZlbnQgYG5hbWVgLlxuXG4gICoqL1xuICBmdW5jdGlvbiBvbihuYW1lLCBoYW5kbGVyKSB7XG4gICAgdmFyIGhhbmRsZXJzO1xuXG4gICAgbmFtZSA9IG5vcm1hbGl6ZShuYW1lKTtcbiAgICBoYW5kbGVycyA9IHJlZ2lzdHJ5W25hbWVdO1xuXG4gICAgaWYgKGhhbmRsZXJzKSB7XG4gICAgICBoYW5kbGVycy5wdXNoKGhhbmRsZXIpO1xuICAgIH1cbiAgICBlbHNlIHtcbiAgICAgIHJlZ2lzdHJ5W25hbWVdID0gWyBoYW5kbGVyIF07XG4gICAgfVxuXG4gICAgcmV0dXJuIGJ1cztcbiAgfVxuXG5cbiAgLyoqXG4gICAgIyMjIGBtYnVzI29uY2UobmFtZSwgaGFuZGxlcilgXG5cbiAgICBSZWdpc3RlciBhbiBldmVudCBoYW5kbGVyIGZvciB0aGUgZXZlbnQgYG5hbWVgIHRoYXQgd2lsbCBvbmx5XG4gICAgdHJpZ2dlciBvbmNlIChpLmUuIHRoZSBoYW5kbGVyIHdpbGwgYmUgZGVyZWdpc3RlcmVkIGltbWVkaWF0ZWx5IGFmdGVyXG4gICAgYmVpbmcgdHJpZ2dlcmVkIHRoZSBmaXJzdCB0aW1lKS5cblxuICAqKi9cbiAgZnVuY3Rpb24gb25jZShuYW1lLCBoYW5kbGVyKSB7XG4gICAgZnVuY3Rpb24gaGFuZGxlRXZlbnQoKSB7XG4gICAgICB2YXIgcmVzdWx0ID0gaGFuZGxlci5hcHBseSh0aGlzLCBhcmd1bWVudHMpO1xuXG4gICAgICBidXMub2ZmKG5hbWUsIGhhbmRsZUV2ZW50KTtcbiAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgaGFuZGxlci5fYWN0dWFsID0gaGFuZGxlRXZlbnQ7XG4gICAgcmV0dXJuIG9uKG5hbWUsIGhhbmRsZUV2ZW50KTtcbiAgfVxuXG4gIGlmICh0eXBlb2YgbmFtZXNwYWNlID09ICdmdW5jdGlvbicpIHtcbiAgICBwYXJlbnQgPSBuYW1lc3BhY2U7XG4gICAgbmFtZXNwYWNlID0gJyc7XG4gIH1cblxuICBuYW1lc3BhY2UgPSBub3JtYWxpemUobmFtZXNwYWNlIHx8ICcnKTtcblxuICBidXMuY2xlYXIgPSBidXMucmVtb3ZlQWxsTGlzdGVuZXJzID0gY2xlYXI7XG4gIGJ1cy5mZWVkID0gZmVlZDtcbiAgYnVzLm9uID0gYnVzLmFkZExpc3RlbmVyID0gb247XG4gIGJ1cy5vbmNlID0gb25jZTtcbiAgYnVzLm9mZiA9IGJ1cy5yZW1vdmVMaXN0ZW5lciA9IG9mZjtcbiAgYnVzLnBhcmVudCA9IHBhcmVudCB8fCAobmFtZXNwYWNlICYmIGNyZWF0ZUJ1cygpKTtcblxuICByZXR1cm4gYnVzO1xufTtcbiIsIi8qKlxuICogRXhwb3NlIGBQcmlvcml0eVF1ZXVlYC5cbiAqL1xubW9kdWxlLmV4cG9ydHMgPSBQcmlvcml0eVF1ZXVlO1xuXG4vKipcbiAqIEluaXRpYWxpemVzIGEgbmV3IGVtcHR5IGBQcmlvcml0eVF1ZXVlYCB3aXRoIHRoZSBnaXZlbiBgY29tcGFyYXRvcihhLCBiKWBcbiAqIGZ1bmN0aW9uLCB1c2VzIGAuREVGQVVMVF9DT01QQVJBVE9SKClgIHdoZW4gbm8gZnVuY3Rpb24gaXMgcHJvdmlkZWQuXG4gKlxuICogVGhlIGNvbXBhcmF0b3IgZnVuY3Rpb24gbXVzdCByZXR1cm4gYSBwb3NpdGl2ZSBudW1iZXIgd2hlbiBgYSA+IGJgLCAwIHdoZW5cbiAqIGBhID09IGJgIGFuZCBhIG5lZ2F0aXZlIG51bWJlciB3aGVuIGBhIDwgYmAuXG4gKlxuICogQHBhcmFtIHtGdW5jdGlvbn1cbiAqIEByZXR1cm4ge1ByaW9yaXR5UXVldWV9XG4gKiBAYXBpIHB1YmxpY1xuICovXG5mdW5jdGlvbiBQcmlvcml0eVF1ZXVlKGNvbXBhcmF0b3IpIHtcbiAgdGhpcy5fY29tcGFyYXRvciA9IGNvbXBhcmF0b3IgfHwgUHJpb3JpdHlRdWV1ZS5ERUZBVUxUX0NPTVBBUkFUT1I7XG4gIHRoaXMuX2VsZW1lbnRzID0gW107XG59XG5cbi8qKlxuICogQ29tcGFyZXMgYGFgIGFuZCBgYmAsIHdoZW4gYGEgPiBiYCBpdCByZXR1cm5zIGEgcG9zaXRpdmUgbnVtYmVyLCB3aGVuXG4gKiBpdCByZXR1cm5zIDAgYW5kIHdoZW4gYGEgPCBiYCBpdCByZXR1cm5zIGEgbmVnYXRpdmUgbnVtYmVyLlxuICpcbiAqIEBwYXJhbSB7U3RyaW5nfE51bWJlcn0gYVxuICogQHBhcmFtIHtTdHJpbmd8TnVtYmVyfSBiXG4gKiBAcmV0dXJuIHtOdW1iZXJ9XG4gKiBAYXBpIHB1YmxpY1xuICovXG5Qcmlvcml0eVF1ZXVlLkRFRkFVTFRfQ09NUEFSQVRPUiA9IGZ1bmN0aW9uKGEsIGIpIHtcbiAgaWYgKHR5cGVvZiBhID09PSAnbnVtYmVyJyAmJiB0eXBlb2YgYiA9PT0gJ251bWJlcicpIHtcbiAgICByZXR1cm4gYSAtIGI7XG4gIH0gZWxzZSB7XG4gICAgYSA9IGEudG9TdHJpbmcoKTtcbiAgICBiID0gYi50b1N0cmluZygpO1xuXG4gICAgaWYgKGEgPT0gYikgcmV0dXJuIDA7XG5cbiAgICByZXR1cm4gKGEgPiBiKSA/IDEgOiAtMTtcbiAgfVxufTtcblxuLyoqXG4gKiBSZXR1cm5zIHdoZXRoZXIgdGhlIHByaW9yaXR5IHF1ZXVlIGlzIGVtcHR5IG9yIG5vdC5cbiAqXG4gKiBAcmV0dXJuIHtCb29sZWFufVxuICogQGFwaSBwdWJsaWNcbiAqL1xuUHJpb3JpdHlRdWV1ZS5wcm90b3R5cGUuaXNFbXB0eSA9IGZ1bmN0aW9uKCkge1xuICByZXR1cm4gdGhpcy5zaXplKCkgPT09IDA7XG59O1xuXG4vKipcbiAqIFBlZWtzIGF0IHRoZSB0b3AgZWxlbWVudCBvZiB0aGUgcHJpb3JpdHkgcXVldWUuXG4gKlxuICogQHJldHVybiB7T2JqZWN0fVxuICogQHRocm93cyB7RXJyb3J9IHdoZW4gdGhlIHF1ZXVlIGlzIGVtcHR5LlxuICogQGFwaSBwdWJsaWNcbiAqL1xuUHJpb3JpdHlRdWV1ZS5wcm90b3R5cGUucGVlayA9IGZ1bmN0aW9uKCkge1xuICBpZiAodGhpcy5pc0VtcHR5KCkpIHRocm93IG5ldyBFcnJvcignUHJpb3JpdHlRdWV1ZSBpcyBlbXB0eScpO1xuXG4gIHJldHVybiB0aGlzLl9lbGVtZW50c1swXTtcbn07XG5cbi8qKlxuICogRGVxdWV1ZXMgdGhlIHRvcCBlbGVtZW50IG9mIHRoZSBwcmlvcml0eSBxdWV1ZS5cbiAqXG4gKiBAcmV0dXJuIHtPYmplY3R9XG4gKiBAdGhyb3dzIHtFcnJvcn0gd2hlbiB0aGUgcXVldWUgaXMgZW1wdHkuXG4gKiBAYXBpIHB1YmxpY1xuICovXG5Qcmlvcml0eVF1ZXVlLnByb3RvdHlwZS5kZXEgPSBmdW5jdGlvbigpIHtcbiAgdmFyIGZpcnN0ID0gdGhpcy5wZWVrKCk7XG4gIHZhciBsYXN0ID0gdGhpcy5fZWxlbWVudHMucG9wKCk7XG4gIHZhciBzaXplID0gdGhpcy5zaXplKCk7XG5cbiAgaWYgKHNpemUgPT09IDApIHJldHVybiBmaXJzdDtcblxuICB0aGlzLl9lbGVtZW50c1swXSA9IGxhc3Q7XG4gIHZhciBjdXJyZW50ID0gMDtcblxuICB3aGlsZSAoY3VycmVudCA8IHNpemUpIHtcbiAgICB2YXIgbGFyZ2VzdCA9IGN1cnJlbnQ7XG4gICAgdmFyIGxlZnQgPSAoMiAqIGN1cnJlbnQpICsgMTtcbiAgICB2YXIgcmlnaHQgPSAoMiAqIGN1cnJlbnQpICsgMjtcblxuICAgIGlmIChsZWZ0IDwgc2l6ZSAmJiB0aGlzLl9jb21wYXJlKGxlZnQsIGxhcmdlc3QpID49IDApIHtcbiAgICAgIGxhcmdlc3QgPSBsZWZ0O1xuICAgIH1cblxuICAgIGlmIChyaWdodCA8IHNpemUgJiYgdGhpcy5fY29tcGFyZShyaWdodCwgbGFyZ2VzdCkgPj0gMCkge1xuICAgICAgbGFyZ2VzdCA9IHJpZ2h0O1xuICAgIH1cblxuICAgIGlmIChsYXJnZXN0ID09PSBjdXJyZW50KSBicmVhaztcblxuICAgIHRoaXMuX3N3YXAobGFyZ2VzdCwgY3VycmVudCk7XG4gICAgY3VycmVudCA9IGxhcmdlc3Q7XG4gIH1cblxuICByZXR1cm4gZmlyc3Q7XG59O1xuXG4vKipcbiAqIEVucXVldWVzIHRoZSBgZWxlbWVudGAgYXQgdGhlIHByaW9yaXR5IHF1ZXVlIGFuZCByZXR1cm5zIGl0cyBuZXcgc2l6ZS5cbiAqXG4gKiBAcGFyYW0ge09iamVjdH0gZWxlbWVudFxuICogQHJldHVybiB7TnVtYmVyfVxuICogQGFwaSBwdWJsaWNcbiAqL1xuUHJpb3JpdHlRdWV1ZS5wcm90b3R5cGUuZW5xID0gZnVuY3Rpb24oZWxlbWVudCkge1xuICB2YXIgc2l6ZSA9IHRoaXMuX2VsZW1lbnRzLnB1c2goZWxlbWVudCk7XG4gIHZhciBjdXJyZW50ID0gc2l6ZSAtIDE7XG5cbiAgd2hpbGUgKGN1cnJlbnQgPiAwKSB7XG4gICAgdmFyIHBhcmVudCA9IE1hdGguZmxvb3IoKGN1cnJlbnQgLSAxKSAvIDIpO1xuXG4gICAgaWYgKHRoaXMuX2NvbXBhcmUoY3VycmVudCwgcGFyZW50KSA8PSAwKSBicmVhaztcblxuICAgIHRoaXMuX3N3YXAocGFyZW50LCBjdXJyZW50KTtcbiAgICBjdXJyZW50ID0gcGFyZW50O1xuICB9XG5cbiAgcmV0dXJuIHNpemU7XG59O1xuXG4vKipcbiAqIFJldHVybnMgdGhlIHNpemUgb2YgdGhlIHByaW9yaXR5IHF1ZXVlLlxuICpcbiAqIEByZXR1cm4ge051bWJlcn1cbiAqIEBhcGkgcHVibGljXG4gKi9cblByaW9yaXR5UXVldWUucHJvdG90eXBlLnNpemUgPSBmdW5jdGlvbigpIHtcbiAgcmV0dXJuIHRoaXMuX2VsZW1lbnRzLmxlbmd0aDtcbn07XG5cbi8qKlxuICogIEl0ZXJhdGVzIG92ZXIgcXVldWUgZWxlbWVudHNcbiAqXG4gKiAgQHBhcmFtIHtGdW5jdGlvbn0gZm5cbiAqL1xuUHJpb3JpdHlRdWV1ZS5wcm90b3R5cGUuZm9yRWFjaCA9IGZ1bmN0aW9uKGZuKSB7XG4gIHJldHVybiB0aGlzLl9lbGVtZW50cy5mb3JFYWNoKGZuKTtcbn07XG5cbi8qKlxuICogQ29tcGFyZXMgdGhlIHZhbHVlcyBhdCBwb3NpdGlvbiBgYWAgYW5kIGBiYCBpbiB0aGUgcHJpb3JpdHkgcXVldWUgdXNpbmcgaXRzXG4gKiBjb21wYXJhdG9yIGZ1bmN0aW9uLlxuICpcbiAqIEBwYXJhbSB7TnVtYmVyfSBhXG4gKiBAcGFyYW0ge051bWJlcn0gYlxuICogQHJldHVybiB7TnVtYmVyfVxuICogQGFwaSBwcml2YXRlXG4gKi9cblByaW9yaXR5UXVldWUucHJvdG90eXBlLl9jb21wYXJlID0gZnVuY3Rpb24oYSwgYikge1xuICByZXR1cm4gdGhpcy5fY29tcGFyYXRvcih0aGlzLl9lbGVtZW50c1thXSwgdGhpcy5fZWxlbWVudHNbYl0pO1xufTtcblxuLyoqXG4gKiBTd2FwcyB0aGUgdmFsdWVzIGF0IHBvc2l0aW9uIGBhYCBhbmQgYGJgIGluIHRoZSBwcmlvcml0eSBxdWV1ZS5cbiAqXG4gKiBAcGFyYW0ge051bWJlcn0gYVxuICogQHBhcmFtIHtOdW1iZXJ9IGJcbiAqIEBhcGkgcHJpdmF0ZVxuICovXG5Qcmlvcml0eVF1ZXVlLnByb3RvdHlwZS5fc3dhcCA9IGZ1bmN0aW9uKGEsIGIpIHtcbiAgdmFyIGF1eCA9IHRoaXMuX2VsZW1lbnRzW2FdO1xuICB0aGlzLl9lbGVtZW50c1thXSA9IHRoaXMuX2VsZW1lbnRzW2JdO1xuICB0aGlzLl9lbGVtZW50c1tiXSA9IGF1eDtcbn07XG4iLCIvLyBzaGltIGZvciB1c2luZyBwcm9jZXNzIGluIGJyb3dzZXJcbnZhciBwcm9jZXNzID0gbW9kdWxlLmV4cG9ydHMgPSB7fTtcblxuLy8gY2FjaGVkIGZyb20gd2hhdGV2ZXIgZ2xvYmFsIGlzIHByZXNlbnQgc28gdGhhdCB0ZXN0IHJ1bm5lcnMgdGhhdCBzdHViIGl0XG4vLyBkb24ndCBicmVhayB0aGluZ3MuICBCdXQgd2UgbmVlZCB0byB3cmFwIGl0IGluIGEgdHJ5IGNhdGNoIGluIGNhc2UgaXQgaXNcbi8vIHdyYXBwZWQgaW4gc3RyaWN0IG1vZGUgY29kZSB3aGljaCBkb2Vzbid0IGRlZmluZSBhbnkgZ2xvYmFscy4gIEl0J3MgaW5zaWRlIGFcbi8vIGZ1bmN0aW9uIGJlY2F1c2UgdHJ5L2NhdGNoZXMgZGVvcHRpbWl6ZSBpbiBjZXJ0YWluIGVuZ2luZXMuXG5cbnZhciBjYWNoZWRTZXRUaW1lb3V0O1xudmFyIGNhY2hlZENsZWFyVGltZW91dDtcblxuZnVuY3Rpb24gZGVmYXVsdFNldFRpbW91dCgpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ3NldFRpbWVvdXQgaGFzIG5vdCBiZWVuIGRlZmluZWQnKTtcbn1cbmZ1bmN0aW9uIGRlZmF1bHRDbGVhclRpbWVvdXQgKCkge1xuICAgIHRocm93IG5ldyBFcnJvcignY2xlYXJUaW1lb3V0IGhhcyBub3QgYmVlbiBkZWZpbmVkJyk7XG59XG4oZnVuY3Rpb24gKCkge1xuICAgIHRyeSB7XG4gICAgICAgIGlmICh0eXBlb2Ygc2V0VGltZW91dCA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgY2FjaGVkU2V0VGltZW91dCA9IHNldFRpbWVvdXQ7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBjYWNoZWRTZXRUaW1lb3V0ID0gZGVmYXVsdFNldFRpbW91dDtcbiAgICAgICAgfVxuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgY2FjaGVkU2V0VGltZW91dCA9IGRlZmF1bHRTZXRUaW1vdXQ7XG4gICAgfVxuICAgIHRyeSB7XG4gICAgICAgIGlmICh0eXBlb2YgY2xlYXJUaW1lb3V0ID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICBjYWNoZWRDbGVhclRpbWVvdXQgPSBjbGVhclRpbWVvdXQ7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBjYWNoZWRDbGVhclRpbWVvdXQgPSBkZWZhdWx0Q2xlYXJUaW1lb3V0O1xuICAgICAgICB9XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBjYWNoZWRDbGVhclRpbWVvdXQgPSBkZWZhdWx0Q2xlYXJUaW1lb3V0O1xuICAgIH1cbn0gKCkpXG5mdW5jdGlvbiBydW5UaW1lb3V0KGZ1bikge1xuICAgIGlmIChjYWNoZWRTZXRUaW1lb3V0ID09PSBzZXRUaW1lb3V0KSB7XG4gICAgICAgIC8vbm9ybWFsIGVudmlyb21lbnRzIGluIHNhbmUgc2l0dWF0aW9uc1xuICAgICAgICByZXR1cm4gc2V0VGltZW91dChmdW4sIDApO1xuICAgIH1cbiAgICAvLyBpZiBzZXRUaW1lb3V0IHdhc24ndCBhdmFpbGFibGUgYnV0IHdhcyBsYXR0ZXIgZGVmaW5lZFxuICAgIGlmICgoY2FjaGVkU2V0VGltZW91dCA9PT0gZGVmYXVsdFNldFRpbW91dCB8fCAhY2FjaGVkU2V0VGltZW91dCkgJiYgc2V0VGltZW91dCkge1xuICAgICAgICBjYWNoZWRTZXRUaW1lb3V0ID0gc2V0VGltZW91dDtcbiAgICAgICAgcmV0dXJuIHNldFRpbWVvdXQoZnVuLCAwKTtcbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgICAgLy8gd2hlbiB3aGVuIHNvbWVib2R5IGhhcyBzY3Jld2VkIHdpdGggc2V0VGltZW91dCBidXQgbm8gSS5FLiBtYWRkbmVzc1xuICAgICAgICByZXR1cm4gY2FjaGVkU2V0VGltZW91dChmdW4sIDApO1xuICAgIH0gY2F0Y2goZSl7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICAvLyBXaGVuIHdlIGFyZSBpbiBJLkUuIGJ1dCB0aGUgc2NyaXB0IGhhcyBiZWVuIGV2YWxlZCBzbyBJLkUuIGRvZXNuJ3QgdHJ1c3QgdGhlIGdsb2JhbCBvYmplY3Qgd2hlbiBjYWxsZWQgbm9ybWFsbHlcbiAgICAgICAgICAgIHJldHVybiBjYWNoZWRTZXRUaW1lb3V0LmNhbGwobnVsbCwgZnVuLCAwKTtcbiAgICAgICAgfSBjYXRjaChlKXtcbiAgICAgICAgICAgIC8vIHNhbWUgYXMgYWJvdmUgYnV0IHdoZW4gaXQncyBhIHZlcnNpb24gb2YgSS5FLiB0aGF0IG11c3QgaGF2ZSB0aGUgZ2xvYmFsIG9iamVjdCBmb3IgJ3RoaXMnLCBob3BmdWxseSBvdXIgY29udGV4dCBjb3JyZWN0IG90aGVyd2lzZSBpdCB3aWxsIHRocm93IGEgZ2xvYmFsIGVycm9yXG4gICAgICAgICAgICByZXR1cm4gY2FjaGVkU2V0VGltZW91dC5jYWxsKHRoaXMsIGZ1biwgMCk7XG4gICAgICAgIH1cbiAgICB9XG5cblxufVxuZnVuY3Rpb24gcnVuQ2xlYXJUaW1lb3V0KG1hcmtlcikge1xuICAgIGlmIChjYWNoZWRDbGVhclRpbWVvdXQgPT09IGNsZWFyVGltZW91dCkge1xuICAgICAgICAvL25vcm1hbCBlbnZpcm9tZW50cyBpbiBzYW5lIHNpdHVhdGlvbnNcbiAgICAgICAgcmV0dXJuIGNsZWFyVGltZW91dChtYXJrZXIpO1xuICAgIH1cbiAgICAvLyBpZiBjbGVhclRpbWVvdXQgd2Fzbid0IGF2YWlsYWJsZSBidXQgd2FzIGxhdHRlciBkZWZpbmVkXG4gICAgaWYgKChjYWNoZWRDbGVhclRpbWVvdXQgPT09IGRlZmF1bHRDbGVhclRpbWVvdXQgfHwgIWNhY2hlZENsZWFyVGltZW91dCkgJiYgY2xlYXJUaW1lb3V0KSB7XG4gICAgICAgIGNhY2hlZENsZWFyVGltZW91dCA9IGNsZWFyVGltZW91dDtcbiAgICAgICAgcmV0dXJuIGNsZWFyVGltZW91dChtYXJrZXIpO1xuICAgIH1cbiAgICB0cnkge1xuICAgICAgICAvLyB3aGVuIHdoZW4gc29tZWJvZHkgaGFzIHNjcmV3ZWQgd2l0aCBzZXRUaW1lb3V0IGJ1dCBubyBJLkUuIG1hZGRuZXNzXG4gICAgICAgIHJldHVybiBjYWNoZWRDbGVhclRpbWVvdXQobWFya2VyKTtcbiAgICB9IGNhdGNoIChlKXtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIC8vIFdoZW4gd2UgYXJlIGluIEkuRS4gYnV0IHRoZSBzY3JpcHQgaGFzIGJlZW4gZXZhbGVkIHNvIEkuRS4gZG9lc24ndCAgdHJ1c3QgdGhlIGdsb2JhbCBvYmplY3Qgd2hlbiBjYWxsZWQgbm9ybWFsbHlcbiAgICAgICAgICAgIHJldHVybiBjYWNoZWRDbGVhclRpbWVvdXQuY2FsbChudWxsLCBtYXJrZXIpO1xuICAgICAgICB9IGNhdGNoIChlKXtcbiAgICAgICAgICAgIC8vIHNhbWUgYXMgYWJvdmUgYnV0IHdoZW4gaXQncyBhIHZlcnNpb24gb2YgSS5FLiB0aGF0IG11c3QgaGF2ZSB0aGUgZ2xvYmFsIG9iamVjdCBmb3IgJ3RoaXMnLCBob3BmdWxseSBvdXIgY29udGV4dCBjb3JyZWN0IG90aGVyd2lzZSBpdCB3aWxsIHRocm93IGEgZ2xvYmFsIGVycm9yLlxuICAgICAgICAgICAgLy8gU29tZSB2ZXJzaW9ucyBvZiBJLkUuIGhhdmUgZGlmZmVyZW50IHJ1bGVzIGZvciBjbGVhclRpbWVvdXQgdnMgc2V0VGltZW91dFxuICAgICAgICAgICAgcmV0dXJuIGNhY2hlZENsZWFyVGltZW91dC5jYWxsKHRoaXMsIG1hcmtlcik7XG4gICAgICAgIH1cbiAgICB9XG5cblxuXG59XG52YXIgcXVldWUgPSBbXTtcbnZhciBkcmFpbmluZyA9IGZhbHNlO1xudmFyIGN1cnJlbnRRdWV1ZTtcbnZhciBxdWV1ZUluZGV4ID0gLTE7XG5cbmZ1bmN0aW9uIGNsZWFuVXBOZXh0VGljaygpIHtcbiAgICBpZiAoIWRyYWluaW5nIHx8ICFjdXJyZW50UXVldWUpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBkcmFpbmluZyA9IGZhbHNlO1xuICAgIGlmIChjdXJyZW50UXVldWUubGVuZ3RoKSB7XG4gICAgICAgIHF1ZXVlID0gY3VycmVudFF1ZXVlLmNvbmNhdChxdWV1ZSk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgcXVldWVJbmRleCA9IC0xO1xuICAgIH1cbiAgICBpZiAocXVldWUubGVuZ3RoKSB7XG4gICAgICAgIGRyYWluUXVldWUoKTtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIGRyYWluUXVldWUoKSB7XG4gICAgaWYgKGRyYWluaW5nKSB7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdmFyIHRpbWVvdXQgPSBydW5UaW1lb3V0KGNsZWFuVXBOZXh0VGljayk7XG4gICAgZHJhaW5pbmcgPSB0cnVlO1xuXG4gICAgdmFyIGxlbiA9IHF1ZXVlLmxlbmd0aDtcbiAgICB3aGlsZShsZW4pIHtcbiAgICAgICAgY3VycmVudFF1ZXVlID0gcXVldWU7XG4gICAgICAgIHF1ZXVlID0gW107XG4gICAgICAgIHdoaWxlICgrK3F1ZXVlSW5kZXggPCBsZW4pIHtcbiAgICAgICAgICAgIGlmIChjdXJyZW50UXVldWUpIHtcbiAgICAgICAgICAgICAgICBjdXJyZW50UXVldWVbcXVldWVJbmRleF0ucnVuKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgcXVldWVJbmRleCA9IC0xO1xuICAgICAgICBsZW4gPSBxdWV1ZS5sZW5ndGg7XG4gICAgfVxuICAgIGN1cnJlbnRRdWV1ZSA9IG51bGw7XG4gICAgZHJhaW5pbmcgPSBmYWxzZTtcbiAgICBydW5DbGVhclRpbWVvdXQodGltZW91dCk7XG59XG5cbnByb2Nlc3MubmV4dFRpY2sgPSBmdW5jdGlvbiAoZnVuKSB7XG4gICAgdmFyIGFyZ3MgPSBuZXcgQXJyYXkoYXJndW1lbnRzLmxlbmd0aCAtIDEpO1xuICAgIGlmIChhcmd1bWVudHMubGVuZ3RoID4gMSkge1xuICAgICAgICBmb3IgKHZhciBpID0gMTsgaSA8IGFyZ3VtZW50cy5sZW5ndGg7IGkrKykge1xuICAgICAgICAgICAgYXJnc1tpIC0gMV0gPSBhcmd1bWVudHNbaV07XG4gICAgICAgIH1cbiAgICB9XG4gICAgcXVldWUucHVzaChuZXcgSXRlbShmdW4sIGFyZ3MpKTtcbiAgICBpZiAocXVldWUubGVuZ3RoID09PSAxICYmICFkcmFpbmluZykge1xuICAgICAgICBydW5UaW1lb3V0KGRyYWluUXVldWUpO1xuICAgIH1cbn07XG5cbi8vIHY4IGxpa2VzIHByZWRpY3RpYmxlIG9iamVjdHNcbmZ1bmN0aW9uIEl0ZW0oZnVuLCBhcnJheSkge1xuICAgIHRoaXMuZnVuID0gZnVuO1xuICAgIHRoaXMuYXJyYXkgPSBhcnJheTtcbn1cbkl0ZW0ucHJvdG90eXBlLnJ1biA9IGZ1bmN0aW9uICgpIHtcbiAgICB0aGlzLmZ1bi5hcHBseShudWxsLCB0aGlzLmFycmF5KTtcbn07XG5wcm9jZXNzLnRpdGxlID0gJ2Jyb3dzZXInO1xucHJvY2Vzcy5icm93c2VyID0gdHJ1ZTtcbnByb2Nlc3MuZW52ID0ge307XG5wcm9jZXNzLmFyZ3YgPSBbXTtcbnByb2Nlc3MudmVyc2lvbiA9ICcnOyAvLyBlbXB0eSBzdHJpbmcgdG8gYXZvaWQgcmVnZXhwIGlzc3Vlc1xucHJvY2Vzcy52ZXJzaW9ucyA9IHt9O1xuXG5mdW5jdGlvbiBub29wKCkge31cblxucHJvY2Vzcy5vbiA9IG5vb3A7XG5wcm9jZXNzLmFkZExpc3RlbmVyID0gbm9vcDtcbnByb2Nlc3Mub25jZSA9IG5vb3A7XG5wcm9jZXNzLm9mZiA9IG5vb3A7XG5wcm9jZXNzLnJlbW92ZUxpc3RlbmVyID0gbm9vcDtcbnByb2Nlc3MucmVtb3ZlQWxsTGlzdGVuZXJzID0gbm9vcDtcbnByb2Nlc3MuZW1pdCA9IG5vb3A7XG5cbnByb2Nlc3MuYmluZGluZyA9IGZ1bmN0aW9uIChuYW1lKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdwcm9jZXNzLmJpbmRpbmcgaXMgbm90IHN1cHBvcnRlZCcpO1xufTtcblxucHJvY2Vzcy5jd2QgPSBmdW5jdGlvbiAoKSB7IHJldHVybiAnLycgfTtcbnByb2Nlc3MuY2hkaXIgPSBmdW5jdGlvbiAoZGlyKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdwcm9jZXNzLmNoZGlyIGlzIG5vdCBzdXBwb3J0ZWQnKTtcbn07XG5wcm9jZXNzLnVtYXNrID0gZnVuY3Rpb24oKSB7IHJldHVybiAwOyB9O1xuIiwiLyoqXG4gICMjIyBgcmV1L2lwYFxuXG4gIEEgcmVndWxhciBleHByZXNzaW9uIHRoYXQgd2lsbCBtYXRjaCBib3RoIElQdjQgYW5kIElQdjYgYWRkcmVzc2VzLiAgVGhpcyBpcyBhIG1vZGlmaWVkXG4gIHJlZ2V4IChyZW1vdmUgaG9zdG5hbWUgbWF0Y2hpbmcpIHRoYXQgd2FzIGltcGxlbWVudGVkIGJ5IEBNaWt1bGFzIGluXG4gIFt0aGlzIHN0YWNrb3ZlcmZsb3cgYW5zd2VyXShodHRwOi8vc3RhY2tvdmVyZmxvdy5jb20vYS85MjA5NzIwLzk2NjU2KS5cblxuKiovXG5tb2R1bGUuZXhwb3J0cyA9IC9eKChbMC05XXxbMS05XVswLTldfDFbMC05XXsyfXwyWzAtNF1bMC05XXwyNVswLTVdKVxcLil7M30oWzAtOV18WzEtOV1bMC05XXwxWzAtOV17Mn18MlswLTRdWzAtOV18MjVbMC01XSkkfF4oPzooPzooPzooPzooPzooPzooPzpbMC05YS1mQS1GXXsxLDR9KSk6KXs2fSkoPzooPzooPzooPzooPzpbMC05YS1mQS1GXXsxLDR9KSk6KD86KD86WzAtOWEtZkEtRl17MSw0fSkpKXwoPzooPzooPzooPzooPzoyNVswLTVdfCg/OlsxLTldfDFbMC05XXwyWzAtNF0pP1swLTldKSlcXC4pezN9KD86KD86MjVbMC01XXwoPzpbMS05XXwxWzAtOV18MlswLTRdKT9bMC05XSkpKSkpKSl8KD86KD86OjooPzooPzooPzpbMC05YS1mQS1GXXsxLDR9KSk6KXs1fSkoPzooPzooPzooPzooPzpbMC05YS1mQS1GXXsxLDR9KSk6KD86KD86WzAtOWEtZkEtRl17MSw0fSkpKXwoPzooPzooPzooPzooPzoyNVswLTVdfCg/OlsxLTldfDFbMC05XXwyWzAtNF0pP1swLTldKSlcXC4pezN9KD86KD86MjVbMC01XXwoPzpbMS05XXwxWzAtOV18MlswLTRdKT9bMC05XSkpKSkpKSl8KD86KD86KD86KD86KD86WzAtOWEtZkEtRl17MSw0fSkpKT86Oig/Oig/Oig/OlswLTlhLWZBLUZdezEsNH0pKTopezR9KSg/Oig/Oig/Oig/Oig/OlswLTlhLWZBLUZdezEsNH0pKTooPzooPzpbMC05YS1mQS1GXXsxLDR9KSkpfCg/Oig/Oig/Oig/Oig/OjI1WzAtNV18KD86WzEtOV18MVswLTldfDJbMC00XSk/WzAtOV0pKVxcLil7M30oPzooPzoyNVswLTVdfCg/OlsxLTldfDFbMC05XXwyWzAtNF0pP1swLTldKSkpKSkpKXwoPzooPzooPzooPzooPzooPzpbMC05YS1mQS1GXXsxLDR9KSk6KXswLDF9KD86KD86WzAtOWEtZkEtRl17MSw0fSkpKT86Oig/Oig/Oig/OlswLTlhLWZBLUZdezEsNH0pKTopezN9KSg/Oig/Oig/Oig/Oig/OlswLTlhLWZBLUZdezEsNH0pKTooPzooPzpbMC05YS1mQS1GXXsxLDR9KSkpfCg/Oig/Oig/Oig/Oig/OjI1WzAtNV18KD86WzEtOV18MVswLTldfDJbMC00XSk/WzAtOV0pKVxcLil7M30oPzooPzoyNVswLTVdfCg/OlsxLTldfDFbMC05XXwyWzAtNF0pP1swLTldKSkpKSkpKXwoPzooPzooPzooPzooPzooPzpbMC05YS1mQS1GXXsxLDR9KSk6KXswLDJ9KD86KD86WzAtOWEtZkEtRl17MSw0fSkpKT86Oig/Oig/Oig/OlswLTlhLWZBLUZdezEsNH0pKTopezJ9KSg/Oig/Oig/Oig/Oig/OlswLTlhLWZBLUZdezEsNH0pKTooPzooPzpbMC05YS1mQS1GXXsxLDR9KSkpfCg/Oig/Oig/Oig/Oig/OjI1WzAtNV18KD86WzEtOV18MVswLTldfDJbMC00XSk/WzAtOV0pKVxcLil7M30oPzooPzoyNVswLTVdfCg/OlsxLTldfDFbMC05XXwyWzAtNF0pP1swLTldKSkpKSkpKXwoPzooPzooPzooPzooPzooPzpbMC05YS1mQS1GXXsxLDR9KSk6KXswLDN9KD86KD86WzAtOWEtZkEtRl17MSw0fSkpKT86Oig/Oig/OlswLTlhLWZBLUZdezEsNH0pKTopKD86KD86KD86KD86KD86WzAtOWEtZkEtRl17MSw0fSkpOig/Oig/OlswLTlhLWZBLUZdezEsNH0pKSl8KD86KD86KD86KD86KD86MjVbMC01XXwoPzpbMS05XXwxWzAtOV18MlswLTRdKT9bMC05XSkpXFwuKXszfSg/Oig/OjI1WzAtNV18KD86WzEtOV18MVswLTldfDJbMC00XSk/WzAtOV0pKSkpKSkpfCg/Oig/Oig/Oig/Oig/Oig/OlswLTlhLWZBLUZdezEsNH0pKTopezAsNH0oPzooPzpbMC05YS1mQS1GXXsxLDR9KSkpPzo6KSg/Oig/Oig/Oig/Oig/OlswLTlhLWZBLUZdezEsNH0pKTooPzooPzpbMC05YS1mQS1GXXsxLDR9KSkpfCg/Oig/Oig/Oig/Oig/OjI1WzAtNV18KD86WzEtOV18MVswLTldfDJbMC00XSk/WzAtOV0pKVxcLil7M30oPzooPzoyNVswLTVdfCg/OlsxLTldfDFbMC05XXwyWzAtNF0pP1swLTldKSkpKSkpKXwoPzooPzooPzooPzooPzooPzpbMC05YS1mQS1GXXsxLDR9KSk6KXswLDV9KD86KD86WzAtOWEtZkEtRl17MSw0fSkpKT86OikoPzooPzpbMC05YS1mQS1GXXsxLDR9KSkpfCg/Oig/Oig/Oig/Oig/Oig/OlswLTlhLWZBLUZdezEsNH0pKTopezAsNn0oPzooPzpbMC05YS1mQS1GXXsxLDR9KSkpPzo6KSkpKSQvO1xuIiwiLyoganNoaW50IG5vZGU6IHRydWUgKi9cbi8qIGdsb2JhbCB3aW5kb3c6IGZhbHNlICovXG4vKiBnbG9iYWwgbmF2aWdhdG9yOiBmYWxzZSAqL1xuXG4ndXNlIHN0cmljdCc7XG5cbnZhciBicm93c2VyID0gcmVxdWlyZSgnZGV0ZWN0LWJyb3dzZXInKTtcblxuLyoqXG4gICMjIyBgcnRjLWNvcmUvZGV0ZWN0YFxuXG4gIEEgYnJvd3NlciBkZXRlY3Rpb24gaGVscGVyIGZvciBhY2Nlc3NpbmcgcHJlZml4LWZyZWUgdmVyc2lvbnMgb2YgdGhlIHZhcmlvdXNcbiAgV2ViUlRDIHR5cGVzLlxuXG4gICMjIyBFeGFtcGxlIFVzYWdlXG5cbiAgSWYgeW91IHdhbnRlZCB0byBnZXQgdGhlIG5hdGl2ZSBgUlRDUGVlckNvbm5lY3Rpb25gIHByb3RvdHlwZSBpbiBhbnkgYnJvd3NlclxuICB5b3UgY291bGQgZG8gdGhlIGZvbGxvd2luZzpcblxuICBgYGBqc1xuICB2YXIgZGV0ZWN0ID0gcmVxdWlyZSgncnRjLWNvcmUvZGV0ZWN0Jyk7IC8vIGFsc28gYXZhaWxhYmxlIGluIHJ0Yy9kZXRlY3RcbiAgdmFyIFJUQ1BlZXJDb25uZWN0aW9uID0gZGV0ZWN0KCdSVENQZWVyQ29ubmVjdGlvbicpO1xuICBgYGBcblxuICBUaGlzIHdvdWxkIHByb3ZpZGUgd2hhdGV2ZXIgdGhlIGJyb3dzZXIgcHJlZml4ZWQgdmVyc2lvbiBvZiB0aGVcbiAgUlRDUGVlckNvbm5lY3Rpb24gaXMgYXZhaWxhYmxlIChgd2Via2l0UlRDUGVlckNvbm5lY3Rpb25gLFxuICBgbW96UlRDUGVlckNvbm5lY3Rpb25gLCBldGMpLlxuKiovXG52YXIgZGV0ZWN0ID0gbW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbih0YXJnZXQsIG9wdHMpIHtcbiAgdmFyIGF0dGFjaCA9IChvcHRzIHx8IHt9KS5hdHRhY2g7XG4gIHZhciBwcmVmaXhJZHg7XG4gIHZhciBwcmVmaXg7XG4gIHZhciB0ZXN0TmFtZTtcbiAgdmFyIGhvc3RPYmplY3QgPSB0aGlzIHx8ICh0eXBlb2Ygd2luZG93ICE9ICd1bmRlZmluZWQnID8gd2luZG93IDogdW5kZWZpbmVkKTtcblxuICAvLyBpbml0aWFsaXNlIHRvIGRlZmF1bHQgcHJlZml4ZXNcbiAgLy8gKHJldmVyc2Ugb3JkZXIgYXMgd2UgdXNlIGEgZGVjcmVtZW50aW5nIGZvciBsb29wKVxuICB2YXIgcHJlZml4ZXMgPSAoKG9wdHMgfHwge30pLnByZWZpeGVzIHx8IFsnbXMnLCAnbycsICdtb3onLCAnd2Via2l0J10pLmNvbmNhdCgnJyk7XG5cbiAgLy8gaWYgd2UgaGF2ZSBubyBob3N0IG9iamVjdCwgdGhlbiBhYm9ydFxuICBpZiAoISBob3N0T2JqZWN0KSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gaXRlcmF0ZSB0aHJvdWdoIHRoZSBwcmVmaXhlcyBhbmQgcmV0dXJuIHRoZSBjbGFzcyBpZiBmb3VuZCBpbiBnbG9iYWxcbiAgZm9yIChwcmVmaXhJZHggPSBwcmVmaXhlcy5sZW5ndGg7IHByZWZpeElkeC0tOyApIHtcbiAgICBwcmVmaXggPSBwcmVmaXhlc1twcmVmaXhJZHhdO1xuXG4gICAgLy8gY29uc3RydWN0IHRoZSB0ZXN0IGNsYXNzIG5hbWVcbiAgICAvLyBpZiB3ZSBoYXZlIGEgcHJlZml4IGVuc3VyZSB0aGUgdGFyZ2V0IGhhcyBhbiB1cHBlcmNhc2UgZmlyc3QgY2hhcmFjdGVyXG4gICAgLy8gc3VjaCB0aGF0IGEgdGVzdCBmb3IgZ2V0VXNlck1lZGlhIHdvdWxkIHJlc3VsdCBpbiBhXG4gICAgLy8gc2VhcmNoIGZvciB3ZWJraXRHZXRVc2VyTWVkaWFcbiAgICB0ZXN0TmFtZSA9IHByZWZpeCArIChwcmVmaXggP1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRhcmdldC5jaGFyQXQoMCkudG9VcHBlckNhc2UoKSArIHRhcmdldC5zbGljZSgxKSA6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGFyZ2V0KTtcblxuICAgIGlmICh0eXBlb2YgaG9zdE9iamVjdFt0ZXN0TmFtZV0gIT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgIC8vIHVwZGF0ZSB0aGUgbGFzdCB1c2VkIHByZWZpeFxuICAgICAgZGV0ZWN0LmJyb3dzZXIgPSBkZXRlY3QuYnJvd3NlciB8fCBwcmVmaXgudG9Mb3dlckNhc2UoKTtcblxuICAgICAgaWYgKGF0dGFjaCkge1xuICAgICAgICAgaG9zdE9iamVjdFt0YXJnZXRdID0gaG9zdE9iamVjdFt0ZXN0TmFtZV07XG4gICAgICB9XG5cbiAgICAgIHJldHVybiBob3N0T2JqZWN0W3Rlc3ROYW1lXTtcbiAgICB9XG4gIH1cbn07XG5cbi8vIGRldGVjdCBtb3ppbGxhICh5ZXMsIHRoaXMgZmVlbHMgZGlydHkpXG5kZXRlY3QubW96ID0gdHlwZW9mIG5hdmlnYXRvciAhPSAndW5kZWZpbmVkJyAmJiAhIW5hdmlnYXRvci5tb3pHZXRVc2VyTWVkaWE7XG5cbi8vIHNldCB0aGUgYnJvd3NlciBhbmQgYnJvd3NlciB2ZXJzaW9uXG5kZXRlY3QuYnJvd3NlciA9IGJyb3dzZXIubmFtZTtcbmRldGVjdC5icm93c2VyVmVyc2lvbiA9IGRldGVjdC52ZXJzaW9uID0gYnJvd3Nlci52ZXJzaW9uO1xuIiwiLyoqXG4gICMjIyBgcnRjLWNvcmUvZ2VuaWNlYFxuXG4gIFJlc3BvbmQgYXBwcm9wcmlhdGVseSB0byBvcHRpb25zIHRoYXQgYXJlIHBhc3NlZCB0byBwYWNrYWdlcyBsaWtlXG4gIGBydGMtcXVpY2tjb25uZWN0YCBhbmQgdHJpZ2dlciBhIGBjYWxsYmFja2AgKGVycm9yIGZpcnN0KSB3aXRoIGljZVNlcnZlclxuICB2YWx1ZXMuXG5cbiAgVGhlIGZ1bmN0aW9uIGxvb2tzIGZvciBlaXRoZXIgb2YgdGhlIGZvbGxvd2luZyBrZXlzIGluIHRoZSBvcHRpb25zLCBpblxuICB0aGUgZm9sbG93aW5nIG9yZGVyIG9yIHByZWNlZGVuY2U6XG5cbiAgMS4gYGljZWAgLSB0aGlzIGNhbiBlaXRoZXIgYmUgYW4gYXJyYXkgb2YgaWNlIHNlcnZlciB2YWx1ZXMgb3IgYSBnZW5lcmF0b3JcbiAgICAgZnVuY3Rpb24gKGluIHRoZSBzYW1lIGZvcm1hdCBhcyB0aGlzIGZ1bmN0aW9uKS4gIElmIHRoaXMga2V5IGNvbnRhaW5zIGFcbiAgICAgdmFsdWUgdGhlbiBhbnkgc2VydmVycyBzcGVjaWZpZWQgaW4gdGhlIGBpY2VTZXJ2ZXJzYCBrZXkgKDIpIHdpbGwgYmVcbiAgICAgaWdub3JlZC5cblxuICAyLiBgaWNlU2VydmVyc2AgLSBhbiBhcnJheSBvZiBpY2Ugc2VydmVyIHZhbHVlcy5cbioqL1xubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihvcHRzLCBjYWxsYmFjaykge1xuICB2YXIgaWNlID0gKG9wdHMgfHwge30pLmljZTtcbiAgdmFyIGljZVNlcnZlcnMgPSAob3B0cyB8fCB7fSkuaWNlU2VydmVycztcblxuICBpZiAodHlwZW9mIGljZSA9PSAnZnVuY3Rpb24nKSB7XG4gICAgcmV0dXJuIGljZShvcHRzLCBjYWxsYmFjayk7XG4gIH1cbiAgZWxzZSBpZiAoQXJyYXkuaXNBcnJheShpY2UpKSB7XG4gICAgcmV0dXJuIGNhbGxiYWNrKG51bGwsIFtdLmNvbmNhdChpY2UpKTtcbiAgfVxuXG4gIGNhbGxiYWNrKG51bGwsIFtdLmNvbmNhdChpY2VTZXJ2ZXJzIHx8IFtdKSk7XG59O1xuIiwidmFyIGRldGVjdCA9IHJlcXVpcmUoJy4vZGV0ZWN0Jyk7XG52YXIgcmVxdWlyZWRGdW5jdGlvbnMgPSBbXG4gICdpbml0J1xuXTtcblxuZnVuY3Rpb24gaXNTdXBwb3J0ZWQocGx1Z2luKSB7XG4gIHJldHVybiBwbHVnaW4gJiYgdHlwZW9mIHBsdWdpbi5zdXBwb3J0ZWQgPT0gJ2Z1bmN0aW9uJyAmJiBwbHVnaW4uc3VwcG9ydGVkKGRldGVjdCk7XG59XG5cbmZ1bmN0aW9uIGlzVmFsaWQocGx1Z2luKSB7XG4gIHZhciBzdXBwb3J0ZWRGdW5jdGlvbnMgPSByZXF1aXJlZEZ1bmN0aW9ucy5maWx0ZXIoZnVuY3Rpb24oZm4pIHtcbiAgICByZXR1cm4gdHlwZW9mIHBsdWdpbltmbl0gPT0gJ2Z1bmN0aW9uJztcbiAgfSk7XG5cbiAgcmV0dXJuIHN1cHBvcnRlZEZ1bmN0aW9ucy5sZW5ndGggPT09IHJlcXVpcmVkRnVuY3Rpb25zLmxlbmd0aDtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihwbHVnaW5zKSB7XG4gIHJldHVybiBbXS5jb25jYXQocGx1Z2lucyB8fCBbXSkuZmlsdGVyKGlzU3VwcG9ydGVkKS5maWx0ZXIoaXNWYWxpZClbMF07XG59XG4iLCIvKiBqc2hpbnQgbm9kZTogdHJ1ZSAqL1xuJ3VzZSBzdHJpY3QnO1xuXG52YXIgbnViID0gcmVxdWlyZSgnd2hpc2svbnViJyk7XG52YXIgcGx1Y2sgPSByZXF1aXJlKCd3aGlzay9wbHVjaycpO1xudmFyIGZsYXR0ZW4gPSByZXF1aXJlKCd3aGlzay9mbGF0dGVuJyk7XG52YXIgcmVMaW5lQnJlYWsgPSAvXFxyP1xcbi87XG52YXIgcmVUcmFpbGluZ05ld2xpbmVzID0gL1xccj9cXG4kLztcblxuLy8gbGlzdCBzZHAgbGluZSB0eXBlcyB0aGF0IGFyZSBub3QgXCJzaWduaWZpY2FudFwiXG52YXIgbm9uSGVhZGVyTGluZXMgPSBbICdhJywgJ2MnLCAnYicsICdrJyBdO1xudmFyIHBhcnNlcnMgPSByZXF1aXJlKCcuL3BhcnNlcnMnKTtcblxuLyoqXG4gICMgcnRjLXNkcFxuXG4gIFRoaXMgaXMgYSB1dGlsaXR5IG1vZHVsZSBmb3IgaW50ZXByZXRpbmcgYW5kIHBhdGNoaW5nIHNkcC5cblxuICAjIyBVc2FnZVxuXG4gIFRoZSBgcnRjLXNkcGAgbWFpbiBtb2R1bGUgZXhwb3NlcyBhIHNpbmdsZSBmdW5jdGlvbiB0aGF0IGlzIGNhcGFibGUgb2ZcbiAgcGFyc2luZyBsaW5lcyBvZiBTRFAsIGFuZCBwcm92aWRpbmcgYW4gb2JqZWN0IGFsbG93aW5nIHlvdSB0byBwZXJmb3JtXG4gIG9wZXJhdGlvbnMgb24gdGhvc2UgcGFyc2VkIGxpbmVzOlxuXG4gIGBgYGpzXG4gIHZhciBzZHAgPSByZXF1aXJlKCdydGMtc2RwJykobGluZXMpO1xuICBgYGBcblxuICBUaGUgY3VycmVudGx5IHN1cHBvcnRlZCBvcGVyYXRpb25zIGFyZSBsaXN0ZWQgYmVsb3c6XG5cbioqL1xubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihzZHApIHtcbiAgdmFyIG9wcyA9IHt9O1xuICB2YXIgcGFyc2VkID0gW107XG4gIHZhciBhY3RpdmVDb2xsZWN0b3I7XG5cbiAgLy8gaW5pdGlhbGlzZSB0aGUgbGluZXNcbiAgdmFyIGxpbmVzID0gc2RwLnNwbGl0KHJlTGluZUJyZWFrKS5maWx0ZXIoQm9vbGVhbikubWFwKGZ1bmN0aW9uKGxpbmUpIHtcbiAgICByZXR1cm4gbGluZS5zcGxpdCgnPScpO1xuICB9KTtcblxuICB2YXIgaW5wdXRPcmRlciA9IG51YihsaW5lcy5maWx0ZXIoZnVuY3Rpb24obGluZSkge1xuICAgIHJldHVybiBsaW5lWzBdICYmIG5vbkhlYWRlckxpbmVzLmluZGV4T2YobGluZVswXSkgPCAwO1xuICB9KS5tYXAocGx1Y2soMCkpKTtcblxuICB2YXIgZmluZExpbmUgPSBvcHMuZmluZExpbmUgPSBmdW5jdGlvbih0eXBlLCBpbmRleCkge1xuICAgIHZhciBsaW5lRGF0YSA9IHBhcnNlZC5maWx0ZXIoZnVuY3Rpb24obGluZSkge1xuICAgICAgcmV0dXJuIGxpbmVbMF0gPT09IHR5cGU7XG4gICAgfSlbaW5kZXggfHwgMF07XG5cbiAgICByZXR1cm4gbGluZURhdGEgJiYgbGluZURhdGFbMV07XG4gIH07XG5cbiAgLy8gcHVzaCBpbnRvIHBhcnNlZCBzZWN0aW9uc1xuICBsaW5lcy5mb3JFYWNoKGZ1bmN0aW9uKGxpbmUpIHtcbiAgICB2YXIgY3VzdG9tUGFyc2VyID0gcGFyc2Vyc1tsaW5lWzBdXTtcblxuICAgIGlmIChjdXN0b21QYXJzZXIpIHtcbiAgICAgIGFjdGl2ZUNvbGxlY3RvciA9IGN1c3RvbVBhcnNlcihwYXJzZWQsIGxpbmUpO1xuICAgIH1cbiAgICBlbHNlIGlmIChhY3RpdmVDb2xsZWN0b3IpIHtcbiAgICAgIGFjdGl2ZUNvbGxlY3RvciA9IGFjdGl2ZUNvbGxlY3RvcihsaW5lKTtcbiAgICB9XG4gICAgZWxzZSB7XG4gICAgICBwYXJzZWQucHVzaChsaW5lKTtcbiAgICB9XG4gIH0pO1xuXG4gIC8qKlxuICAgICMjIyBgc2RwLmFkZEljZUNhbmRpZGF0ZShkYXRhKWBcblxuICAgIE1vZGlmeSB0aGUgc2RwIHRvIGluY2x1ZGUgY2FuZGlkYXRlcyBhcyBkZW5vdGVkIGJ5IHRoZSBkYXRhLlxuXG4qKi9cbiAgb3BzLmFkZEljZUNhbmRpZGF0ZSA9IGZ1bmN0aW9uKGRhdGEpIHtcbiAgICB2YXIgbGluZUluZGV4ID0gKGRhdGEgfHwge30pLmxpbmVJbmRleCB8fCAoZGF0YSB8fCB7fSkuc2RwTUxpbmVJbmRleDtcbiAgICB2YXIgbUxpbmUgPSB0eXBlb2YgbGluZUluZGV4ICE9ICd1bmRlZmluZWQnICYmIGZpbmRMaW5lKCdtJywgbGluZUluZGV4KTtcbiAgICB2YXIgY2FuZGlkYXRlID0gKGRhdGEgfHwge30pLmNhbmRpZGF0ZTtcblxuICAgIC8vIGlmIHdlIGhhdmUgdGhlIG1MaW5lIGFkZCB0aGUgbmV3IGNhbmRpZGF0ZVxuICAgIGlmIChtTGluZSAmJiBjYW5kaWRhdGUpIHtcbiAgICAgIG1MaW5lLmNoaWxkbGluZXMucHVzaChjYW5kaWRhdGUucmVwbGFjZShyZVRyYWlsaW5nTmV3bGluZXMsICcnKS5zcGxpdCgnPScpKTtcbiAgICB9XG4gIH07XG5cbiAgLyoqXG4gICAgIyMjIGBzZHAuZ2V0TWVkaWFUeXBlcygpID0+IFtdYFxuXG4gICAgUmV0cmlldmUgdGhlIGxpc3Qgb2YgbWVkaWEgdHlwZXMgdGhhdCBoYXZlIGJlZW4gZGVmaW5lZCBpbiB0aGUgc2RwIHZpYVxuICAgIGBtPWAgbGluZXMuXG4gICoqL1xuICBvcHMuZ2V0TWVkaWFUeXBlcyA9IGZ1bmN0aW9uKCkge1xuICAgIGZ1bmN0aW9uIGdldE1lZGlhVHlwZShkYXRhKSB7XG4gICAgICByZXR1cm4gZGF0YVsxXS5kZWYuc3BsaXQoL1xccy8pWzBdO1xuICAgIH1cblxuICAgIHJldHVybiBwYXJzZWQuZmlsdGVyKGZ1bmN0aW9uKHBhcnRzKSB7XG4gICAgICByZXR1cm4gcGFydHNbMF0gPT09ICdtJyAmJiBwYXJ0c1sxXSAmJiBwYXJ0c1sxXS5kZWY7XG4gICAgfSkubWFwKGdldE1lZGlhVHlwZSk7XG4gIH07XG5cbiAgLyoqXG4gICAgIyMjIGBzZHAuZ2V0TWVkaWFJRHMoKSA9PiBbXWBcblxuICAgIFJldHVybnMgdGhlIGxpc3Qgb2YgdW5pcXVlIG1lZGlhIGxpbmUgSURzIHRoYXQgaGF2ZSBiZWVuIGRlZmluZWQgaW4gdGhlIHNkcFxuICAgIHZpYSBgYT1taWQ6YCBsaW5lcy5cbiAgICoqL1xuICBvcHMuZ2V0TWVkaWFJRHMgPSBmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gcGFyc2VkLmZpbHRlcihmdW5jdGlvbihwYXJ0cykge1xuICAgICAgcmV0dXJuIHBhcnRzWzBdID09PSAnbScgJiYgcGFydHNbMV0gJiYgcGFydHNbMV0uY2hpbGRsaW5lcyAmJiBwYXJ0c1sxXS5jaGlsZGxpbmVzLmxlbmd0aCA+IDA7XG4gICAgfSkubWFwKGZ1bmN0aW9uKG1lZGlhTGluZSkge1xuICAgICAgdmFyIGxpbmVzID0gbWVkaWFMaW5lWzFdLmNoaWxkbGluZXM7XG4gICAgICAvLyBEZWZhdWx0IElEIHRvIHRoZSBtZWRpYSB0eXBlXG4gICAgICB2YXIgbWVkaWFJZCA9IG1lZGlhTGluZVsxXS5kZWYuc3BsaXQoL1xccy8pWzBdO1xuXG4gICAgICAvLyBMb29rIGZvciB0aGUgbWVkaWEgSURcbiAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbGluZXMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgdmFyIHRva2VucyA9IGxpbmVzW2ldWzFdLnNwbGl0KCc6Jyk7XG4gICAgICAgIGlmICh0b2tlbnMubGVuZ3RoID4gMCAmJiB0b2tlbnNbMF0gPT09ICdtaWQnKSB7XG4gICAgICAgICAgbWVkaWFJZCA9IHRva2Vuc1sxXTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmV0dXJuIG1lZGlhSWQ7XG4gICAgfSk7XG4gIH07XG5cbiAgLyoqXG4gICAgIyMjIGBzZHAudG9TdHJpbmcoKWBcblxuICAgIENvbnZlcnQgdGhlIFNEUCBzdHJ1Y3R1cmUgdGhhdCBpcyBjdXJyZW50bHkgcmV0YWluZWQgaW4gbWVtb3J5LCBpbnRvIGEgc3RyaW5nXG4gICAgdGhhdCBjYW4gYmUgcHJvdmlkZWQgdG8gYSBgc2V0TG9jYWxEZXNjcmlwdGlvbmAgKG9yIGBzZXRSZW1vdGVEZXNjcmlwdGlvbmApXG4gICAgV2ViUlRDIGNhbGwuXG5cbiAgKiovXG4gIG9wcy50b1N0cmluZyA9IGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiBwYXJzZWQubWFwKGZ1bmN0aW9uKGxpbmUpIHtcbiAgICAgIHJldHVybiB0eXBlb2YgbGluZVsxXS50b0FycmF5ID09ICdmdW5jdGlvbicgPyBsaW5lWzFdLnRvQXJyYXkoKSA6IFsgbGluZSBdO1xuICAgIH0pLnJlZHVjZShmbGF0dGVuKS5tYXAoZnVuY3Rpb24obGluZSkge1xuICAgICAgcmV0dXJuIGxpbmUuam9pbignPScpO1xuICAgIH0pLmpvaW4oJ1xcclxcbicpICsgJ1xcclxcbic7XG4gIH07XG5cbiAgLyoqXG4gICAgIyMgU0RQIEZpbHRlcmluZyAvIE11bmdpbmcgRnVuY3Rpb25zXG5cbiAgICBUaGVyZSBhcmUgYWRkaXRpb25hbCBmdW5jdGlvbnMgaW5jbHVkZWQgaW4gdGhlIG1vZHVsZSB0byBhc3NpZ24gd2l0aFxuICAgIHBlcmZvcm1pbmcgXCJzaW5nbGUtc2hvdFwiIFNEUCBmaWx0ZXJpbmcgKG9yIG11bmdpbmcpIG9wZXJhdGlvbnM6XG5cbiAgKiovXG5cbiAgcmV0dXJuIG9wcztcbn07XG4iLCIvKiBqc2hpbnQgbm9kZTogdHJ1ZSAqL1xuJ3VzZSBzdHJpY3QnO1xuXG5leHBvcnRzLm0gPSBmdW5jdGlvbihwYXJzZWQsIGxpbmUpIHtcbiAgdmFyIG1lZGlhID0ge1xuICAgIGRlZjogbGluZVsxXSxcbiAgICBjaGlsZGxpbmVzOiBbXSxcblxuICAgIHRvQXJyYXk6IGZ1bmN0aW9uKCkge1xuICAgICAgcmV0dXJuIFtcbiAgICAgICAgWydtJywgbWVkaWEuZGVmIF1cbiAgICAgIF0uY29uY2F0KG1lZGlhLmNoaWxkbGluZXMpO1xuICAgIH1cbiAgfTtcblxuICBmdW5jdGlvbiBhZGRDaGlsZExpbmUoY2hpbGRMaW5lKSB7XG4gICAgbWVkaWEuY2hpbGRsaW5lcy5wdXNoKGNoaWxkTGluZSk7XG4gICAgcmV0dXJuIGFkZENoaWxkTGluZTtcbiAgfVxuXG4gIHBhcnNlZC5wdXNoKFsgJ20nLCBtZWRpYSBdKTtcblxuICByZXR1cm4gYWRkQ2hpbGRMaW5lO1xufTsiLCJ2YXIgdmFsaWRhdG9ycyA9IFtcbiAgWyAvXihhXFw9Y2FuZGlkYXRlLiopJC8sIHJlcXVpcmUoJ3J0Yy12YWxpZGF0b3IvY2FuZGlkYXRlJykgXVxuXTtcblxudmFyIHJlU2RwTGluZUJyZWFrID0gLyhcXHI/XFxufFxcXFxyXFxcXG4pLztcblxuLyoqXG4gICMgcnRjLXNkcGNsZWFuXG5cbiAgUmVtb3ZlIGludmFsaWQgbGluZXMgZnJvbSB5b3VyIFNEUC5cblxuICAjIyBXaHk/XG5cbiAgVGhpcyBtb2R1bGUgcmVtb3ZlcyB0aGUgb2NjYXNpb25hbCBcImJhZCBlZ2dcIiB0aGF0IHdpbGwgc2xpcCBpbnRvIFNEUCB3aGVuIGl0XG4gIGlzIGdlbmVyYXRlZCBieSB0aGUgYnJvd3Nlci4gIEluIHBhcnRpY3VsYXIgdGhlc2Ugc2l0dWF0aW9ucyBhcmUgY2F0ZXJlZCBmb3I6XG5cbiAgLSBpbnZhbGlkIElDRSBjYW5kaWRhdGVzXG5cbioqL1xubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihpbnB1dCwgb3B0cykge1xuICB2YXIgbGluZUJyZWFrID0gZGV0ZWN0TGluZUJyZWFrKGlucHV0KTtcbiAgdmFyIGxpbmVzID0gaW5wdXQuc3BsaXQobGluZUJyZWFrKTtcbiAgdmFyIGNvbGxlY3RvciA9IChvcHRzIHx8IHt9KS5jb2xsZWN0b3I7XG5cbiAgLy8gZmlsdGVyIG91dCBpbnZhbGlkIGxpbmVzXG4gIGxpbmVzID0gbGluZXMuZmlsdGVyKGZ1bmN0aW9uKGxpbmUpIHtcbiAgICAvLyBpdGVyYXRlIHRocm91Z2ggdGhlIHZhbGlkYXRvcnMgYW5kIHVzZSB0aGUgb25lIHRoYXQgbWF0Y2hlc1xuICAgIHZhciB2YWxpZGF0b3IgPSB2YWxpZGF0b3JzLnJlZHVjZShmdW5jdGlvbihtZW1vLCBkYXRhLCBpZHgpIHtcbiAgICAgIHJldHVybiB0eXBlb2YgbWVtbyAhPSAndW5kZWZpbmVkJyA/IG1lbW8gOiAoZGF0YVswXS5leGVjKGxpbmUpICYmIHtcbiAgICAgICAgbGluZTogbGluZS5yZXBsYWNlKGRhdGFbMF0sICckMScpLFxuICAgICAgICBmbjogZGF0YVsxXVxuICAgICAgfSk7XG4gICAgfSwgdW5kZWZpbmVkKTtcblxuICAgIC8vIGlmIHdlIGhhdmUgYSB2YWxpZGF0b3IsIGVuc3VyZSB3ZSBoYXZlIG5vIGVycm9yc1xuICAgIHZhciBlcnJvcnMgPSB2YWxpZGF0b3IgPyB2YWxpZGF0b3IuZm4odmFsaWRhdG9yLmxpbmUpIDogW107XG5cbiAgICAvLyBpZiB3ZSBoYXZlIGVycm9ycyBhbmQgYW4gZXJyb3IgY29sbGVjdG9yLCB0aGVuIGFkZCB0byB0aGUgY29sbGVjdG9yXG4gICAgaWYgKGNvbGxlY3Rvcikge1xuICAgICAgZXJyb3JzLmZvckVhY2goZnVuY3Rpb24oZXJyKSB7XG4gICAgICAgIGNvbGxlY3Rvci5wdXNoKGVycik7XG4gICAgICB9KTtcbiAgICB9XG5cbiAgICByZXR1cm4gZXJyb3JzLmxlbmd0aCA9PT0gMDtcbiAgfSk7XG5cbiAgcmV0dXJuIGxpbmVzLmpvaW4obGluZUJyZWFrKTtcbn07XG5cbmZ1bmN0aW9uIGRldGVjdExpbmVCcmVhayhpbnB1dCkge1xuICB2YXIgbWF0Y2ggPSByZVNkcExpbmVCcmVhay5leGVjKGlucHV0KTtcblxuICByZXR1cm4gbWF0Y2ggJiYgbWF0Y2hbMF07XG59XG4iLCJ2YXIgZGV0ZWN0ID0gcmVxdWlyZSgncnRjLWNvcmUvZGV0ZWN0Jyk7XG52YXIgZmluZFBsdWdpbiA9IHJlcXVpcmUoJ3J0Yy1jb3JlL3BsdWdpbicpO1xudmFyIFByaW9yaXR5UXVldWUgPSByZXF1aXJlKCdwcmlvcml0eXF1ZXVlanMnKTtcbnZhciBQcm9taXNlID0gcmVxdWlyZSgnZXM2LXByb21pc2UnKS5Qcm9taXNlO1xudmFyIHBsdWNrID0gcmVxdWlyZSgnd2hpc2svcGx1Y2snKTtcbnZhciBwbHVja1Nlc3Npb25EZXNjID0gcGx1Y2soJ3NkcCcsICd0eXBlJyk7XG5cbi8vIHNvbWUgdmFsaWRhdGlvbiByb3V0aW5lc1xudmFyIGNoZWNrQ2FuZGlkYXRlID0gcmVxdWlyZSgncnRjLXZhbGlkYXRvci9jYW5kaWRhdGUnKTtcblxuLy8gdGhlIHNkcCBjbGVhbmVyXG52YXIgc2RwY2xlYW4gPSByZXF1aXJlKCdydGMtc2RwY2xlYW4nKTtcbnZhciBwYXJzZVNkcCA9IHJlcXVpcmUoJ3J0Yy1zZHAnKTtcblxudmFyIFBSSU9SSVRZX0xPVyA9IDEwMDtcbnZhciBQUklPUklUWV9XQUlUID0gMTAwMDtcblxuLy8gcHJpb3JpdHkgb3JkZXIgKGxvd2VyIGlzIGJldHRlcilcbnZhciBERUZBVUxUX1BSSU9SSVRJRVMgPSBbXG4gICdjcmVhdGVPZmZlcicsXG4gICdzZXRMb2NhbERlc2NyaXB0aW9uJyxcbiAgJ2NyZWF0ZUFuc3dlcicsXG4gICdzZXRSZW1vdGVEZXNjcmlwdGlvbicsXG4gICdhZGRJY2VDYW5kaWRhdGUnXG5dO1xuXG4vLyBkZWZpbmUgZXZlbnQgbWFwcGluZ3NcbnZhciBNRVRIT0RfRVZFTlRTID0ge1xuICBzZXRMb2NhbERlc2NyaXB0aW9uOiAnc2V0bG9jYWxkZXNjJyxcbiAgc2V0UmVtb3RlRGVzY3JpcHRpb246ICdzZXRyZW1vdGVkZXNjJyxcbiAgY3JlYXRlT2ZmZXI6ICdvZmZlcicsXG4gIGNyZWF0ZUFuc3dlcjogJ2Fuc3dlcidcbn07XG5cbnZhciBNRURJQV9NQVBQSU5HUyA9IHtcbiAgZGF0YTogJ2FwcGxpY2F0aW9uJ1xufTtcblxuLy8gZGVmaW5lIHN0YXRlcyBpbiB3aGljaCB3ZSB3aWxsIGF0dGVtcHQgdG8gZmluYWxpemUgYSBjb25uZWN0aW9uIG9uIHJlY2VpdmluZyBhIHJlbW90ZSBvZmZlclxudmFyIFZBTElEX1JFU1BPTlNFX1NUQVRFUyA9IFsnaGF2ZS1yZW1vdGUtb2ZmZXInLCAnaGF2ZS1sb2NhbC1wcmFuc3dlciddO1xuXG4vKipcbiAgQWxsb3dzIG92ZXJyaWRpbmcgb2YgYSBmdW5jdGlvblxuICoqL1xuZnVuY3Rpb24gcGx1Z2dhYmxlKHBsdWdpbkZuLCBkZWZhdWx0Rm4pIHtcbiAgcmV0dXJuIChwbHVnaW5GbiAmJiB0eXBlb2YgcGx1Z2luRm4gPT0gJ2Z1bmN0aW9uJyA/IHBsdWdpbkZuIDogZGVmYXVsdEZuKTtcbn1cblxuLyoqXG4gICMgcnRjLXRhc2txdWV1ZVxuXG4gIFRoaXMgaXMgYSBwYWNrYWdlIHRoYXQgYXNzaXN0cyB3aXRoIGFwcGx5aW5nIGFjdGlvbnMgdG8gYW4gYFJUQ1BlZXJDb25uZWN0aW9uYFxuICBpbiBhcyByZWxpYWJsZSBvcmRlciBhcyBwb3NzaWJsZS4gSXQgaXMgcHJpbWFyaWx5IHVzZWQgYnkgdGhlIGNvdXBsaW5nIGxvZ2ljXG4gIG9mIHRoZSBbYHJ0Yy10b29sc2BdKGh0dHBzOi8vZ2l0aHViLmNvbS9ydGMtaW8vcnRjLXRvb2xzKS5cblxuICAjIyBFeGFtcGxlIFVzYWdlXG5cbiAgRm9yIHRoZSBtb21lbnQsIHJlZmVyIHRvIHRoZSBzaW1wbGUgY291cGxpbmcgdGVzdCBhcyBhbiBleGFtcGxlIG9mIGhvdyB0byB1c2VcbiAgdGhpcyBwYWNrYWdlIChzZWUgYmVsb3cpOlxuXG4gIDw8PCB0ZXN0L2NvdXBsZS5qc1xuXG4qKi9cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24ocGMsIG9wdHMpIHtcbiAgb3B0cyA9IG9wdHMgfHwge307XG4gIC8vIGNyZWF0ZSB0aGUgdGFzayBxdWV1ZVxuICB2YXIgcXVldWUgPSBuZXcgUHJpb3JpdHlRdWV1ZShvcmRlclRhc2tzKTtcbiAgdmFyIHRxID0gcmVxdWlyZSgnbWJ1cycpKCcnLCAob3B0cyB8fCB7fSkubG9nZ2VyKTtcblxuICAvLyBpbml0aWFsaXNlIHRhc2sgaW1wb3J0YW5jZVxuICB2YXIgcHJpb3JpdGllcyA9IChvcHRzIHx8IHt9KS5wcmlvcml0aWVzIHx8IERFRkFVTFRfUFJJT1JJVElFUztcbiAgdmFyIHF1ZXVlSW50ZXJ2YWwgPSAob3B0cyB8fCB7fSkuaW50ZXJ2YWwgfHwgMTA7XG5cbiAgLy8gY2hlY2sgZm9yIHBsdWdpbiB1c2FnZVxuICB2YXIgcGx1Z2luID0gZmluZFBsdWdpbigob3B0cyB8fCB7fSkucGx1Z2lucyk7XG5cbiAgLy8gaW5pdGlhbGlzZSBzdGF0ZSB0cmFja2luZ1xuICB2YXIgY2hlY2tRdWV1ZVRpbWVyID0gMDtcbiAgdmFyIGRlZmF1bHRGYWlsID0gdHEuYmluZCh0cSwgJ2ZhaWwnKTtcblxuICAvLyBsb29rIGZvciBhbiBzZHBmaWx0ZXIgZnVuY3Rpb24gKGFsbG93IHNsaWdodCBtaXMtc3BlbGxpbmdzKVxuICB2YXIgc2RwRmlsdGVyID0gKG9wdHMgfHwge30pLnNkcGZpbHRlciB8fCAob3B0cyB8fCB7fSkuc2RwRmlsdGVyO1xuICB2YXIgYWx3YXlzUGFyc2UgPSAob3B0cy5zZHBQYXJzZU1vZGUgPT09ICdhbHdheXMnKTtcblxuICAvLyBpbml0aWFsaXNlIHNlc3Npb24gZGVzY3JpcHRpb24gYW5kIGljZWNhbmRpZGF0ZSBvYmplY3RzXG4gIHZhciBSVENTZXNzaW9uRGVzY3JpcHRpb24gPSAob3B0cyB8fCB7fSkuUlRDU2Vzc2lvbkRlc2NyaXB0aW9uIHx8XG4gICAgZGV0ZWN0KCdSVENTZXNzaW9uRGVzY3JpcHRpb24nKTtcblxuICB2YXIgUlRDSWNlQ2FuZGlkYXRlID0gKG9wdHMgfHwge30pLlJUQ0ljZUNhbmRpZGF0ZSB8fFxuICAgIGRldGVjdCgnUlRDSWNlQ2FuZGlkYXRlJyk7XG5cbiAgLy8gRGV0ZXJtaW5lIHBsdWdpbiBvdmVycmlkYWJsZSBtZXRob2RzXG4gIHZhciBjcmVhdGVJY2VDYW5kaWRhdGUgPSBwbHVnZ2FibGUocGx1Z2luICYmIHBsdWdpbi5jcmVhdGVJY2VDYW5kaWRhdGUsIGZ1bmN0aW9uKGRhdGEpIHtcbiAgICByZXR1cm4gbmV3IFJUQ0ljZUNhbmRpZGF0ZShkYXRhKTtcbiAgfSk7XG5cbiAgdmFyIGNyZWF0ZVNlc3Npb25EZXNjcmlwdGlvbiA9IHBsdWdnYWJsZShwbHVnaW4gJiYgcGx1Z2luLmNyZWF0ZVNlc3Npb25EZXNjcmlwdGlvbiwgZnVuY3Rpb24oZGF0YSkge1xuICAgIHJldHVybiBuZXcgUlRDU2Vzc2lvbkRlc2NyaXB0aW9uKGRhdGEpO1xuICB9KTtcblxuICB2YXIgcWlkID0gdHEuX3FpZCA9IE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIDEwMDAwMCk7XG5cbiAgZnVuY3Rpb24gYWJvcnRRdWV1ZShlcnIpIHtcbiAgICBjb25zb2xlLmVycm9yKGVycik7XG4gIH1cblxuICBmdW5jdGlvbiBhcHBseUNhbmRpZGF0ZSh0YXNrLCBuZXh0KSB7XG4gICAgdmFyIGRhdGEgPSB0YXNrLmFyZ3NbMF07XG4gICAgLy8gQWxsb3cgc2VsZWN0aXZlIGZpbHRlcmluZyBvZiBJQ0UgY2FuZGlkYXRlc1xuICAgIGlmIChvcHRzICYmIG9wdHMuZmlsdGVyQ2FuZGlkYXRlICYmICFvcHRzLmZpbHRlckNhbmRpZGF0ZShkYXRhKSkge1xuICAgICAgdHEoJ2ljZS5yZW1vdGUuZmlsdGVyZWQnLCBjYW5kaWRhdGUpO1xuICAgICAgcmV0dXJuIG5leHQoKTtcbiAgICB9XG4gICAgdmFyIGNhbmRpZGF0ZSA9IGRhdGEgJiYgZGF0YS5jYW5kaWRhdGUgJiYgY3JlYXRlSWNlQ2FuZGlkYXRlKGRhdGEpO1xuXG4gICAgZnVuY3Rpb24gaGFuZGxlT2soKSB7XG4gICAgICB0cSgnaWNlLnJlbW90ZS5hcHBsaWVkJywgY2FuZGlkYXRlKTtcbiAgICAgIG5leHQoKTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBoYW5kbGVGYWlsKGVycikge1xuICAgICAgdHEoJ2ljZS5yZW1vdGUuaW52YWxpZCcsIGNhbmRpZGF0ZSk7XG4gICAgICBuZXh0KGVycik7XG4gICAgfVxuXG4gICAgLy8gd2UgaGF2ZSBhIG51bGwgY2FuZGlkYXRlLCB3ZSBoYXZlIGZpbmlzaGVkIGdhdGhlcmluZyBjYW5kaWRhdGVzXG4gICAgaWYgKCEgY2FuZGlkYXRlKSB7XG4gICAgICByZXR1cm4gbmV4dCgpO1xuICAgIH1cblxuICAgIHBjLmFkZEljZUNhbmRpZGF0ZShjYW5kaWRhdGUsIGhhbmRsZU9rLCBoYW5kbGVGYWlsKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGNoZWNrUXVldWUoKSB7XG4gICAgLy8gcGVlayBhdCB0aGUgbmV4dCBpdGVtIG9uIHRoZSBxdWV1ZVxuICAgIHZhciBuZXh0ID0gKCEgcXVldWUuaXNFbXB0eSgpKSAmJiBxdWV1ZS5wZWVrKCk7XG4gICAgdmFyIHJlYWR5ID0gbmV4dCAmJiB0ZXN0UmVhZHkobmV4dCk7XG5cbiAgICAvLyByZXNldCB0aGUgcXVldWUgdGltZXJcbiAgICBjaGVja1F1ZXVlVGltZXIgPSAwO1xuXG4gICAgLy8gaWYgd2UgZG9uJ3QgaGF2ZSBhIHRhc2sgcmVhZHksIHRoZW4gYWJvcnRcbiAgICBpZiAoISByZWFkeSkge1xuICAgICAgLy8gaWYgd2UgaGF2ZSBhIHRhc2sgYW5kIGl0IGhhcyBleHBpcmVkIHRoZW4gZGVxdWV1ZSBpdFxuICAgICAgaWYgKG5leHQgJiYgKGFib3J0ZWQobmV4dCkgfHwgZXhwaXJlZChuZXh0KSkpIHtcbiAgICAgICAgdHEoJ3Rhc2suZXhwaXJlJywgbmV4dCk7XG4gICAgICAgIHF1ZXVlLmRlcSgpO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gKCEgcXVldWUuaXNFbXB0eSgpKSAmJiBpc05vdENsb3NlZChwYykgJiYgdHJpZ2dlclF1ZXVlQ2hlY2soKTtcbiAgICB9XG5cbiAgICAvLyBwcm9wZXJseSBkZXF1ZXVlIHRhc2tcbiAgICBuZXh0ID0gcXVldWUuZGVxKCk7XG5cbiAgICAvLyBwcm9jZXNzIHRoZSB0YXNrXG4gICAgbmV4dC5mbihuZXh0LCBmdW5jdGlvbihlcnIpIHtcbiAgICAgIHZhciBmYWlsID0gbmV4dC5mYWlsIHx8IGRlZmF1bHRGYWlsO1xuICAgICAgdmFyIHBhc3MgPSBuZXh0LnBhc3M7XG4gICAgICB2YXIgdGFza05hbWUgPSBuZXh0Lm5hbWU7XG5cbiAgICAgIC8vIGlmIGVycm9yZWQsIGZhaWxcbiAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgY29uc29sZS5lcnJvcih0YXNrTmFtZSArICcgdGFzayBmYWlsZWQ6ICcsIGVycik7XG4gICAgICAgIHJldHVybiBmYWlsKGVycik7XG4gICAgICB9XG5cbiAgICAgIGlmICh0eXBlb2YgcGFzcyA9PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIHBhc3MuYXBwbHkobmV4dCwgW10uc2xpY2UuY2FsbChhcmd1bWVudHMsIDEpKTtcbiAgICAgIH1cblxuICAgICAgLy8gQWxsb3cgdGFza3MgdG8gaW5kaWNhdGUgdGhhdCBwcm9jZXNzaW5nIHNob3VsZCBjb250aW51ZSBpbW1lZGlhdGVseSB0byB0aGVcbiAgICAgIC8vIGZvbGxvd2luZyB0YXNrXG4gICAgICBpZiAobmV4dC5pbW1lZGlhdGUpIHtcbiAgICAgICAgaWYgKGNoZWNrUXVldWVUaW1lcikgY2xlYXJUaW1lb3V0KGNoZWNrUXVldWVUaW1lcik7XG4gICAgICAgIHJldHVybiBjaGVja1F1ZXVlKCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0cmlnZ2VyUXVldWVDaGVjaygpO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG5cbiAgZnVuY3Rpb24gY2xlYW5zZHAoZGVzYykge1xuICAgIC8vIGVuc3VyZSB3ZSBoYXZlIGNsZWFuIHNkcFxuICAgIHZhciBzZHBFcnJvcnMgPSBbXTtcbiAgICB2YXIgc2RwID0gZGVzYyAmJiBzZHBjbGVhbihkZXNjLnNkcCwgeyBjb2xsZWN0b3I6IHNkcEVycm9ycyB9KTtcblxuICAgIC8vIGlmIHdlIGRvbid0IGhhdmUgYSBtYXRjaCwgbG9nIHNvbWUgaW5mb1xuICAgIGlmIChkZXNjICYmIHNkcCAhPT0gZGVzYy5zZHApIHtcbiAgICAgIGNvbnNvbGUuaW5mbygnaW52YWxpZCBsaW5lcyByZW1vdmVkIGZyb20gc2RwOiAnLCBzZHBFcnJvcnMpO1xuICAgICAgZGVzYy5zZHAgPSBzZHA7XG4gICAgfVxuXG4gICAgLy8gaWYgYSBmaWx0ZXIgaGFzIGJlZW4gc3BlY2lmaWVkLCB0aGVuIGFwcGx5IHRoZSBmaWx0ZXJcbiAgICBpZiAodHlwZW9mIHNkcEZpbHRlciA9PSAnZnVuY3Rpb24nKSB7XG4gICAgICBkZXNjLnNkcCA9IHNkcEZpbHRlcihkZXNjLnNkcCwgcGMpO1xuICAgIH1cblxuICAgIHJldHVybiBkZXNjO1xuICB9XG5cbiAgZnVuY3Rpb24gY29tcGxldGVDb25uZWN0aW9uKCkge1xuICAgIC8vIENsZWFuIGFueSBjYWNoZWQgbWVkaWEgdHlwZXMgbm93IHRoYXQgd2UgaGF2ZSBwb3RlbnRpYWxseSBuZXcgcmVtb3RlIGRlc2NyaXB0aW9uXG4gICAgaWYgKHBjLl9fbWVkaWFJRHMgfHwgcGMuX19tZWRpYVR5cGVzKSB7XG4gICAgICAvLyBTZXQgZGVmaW5lZCBhcyBvcHBvc2VkIHRvIGRlbGV0ZSwgZm9yIGNvbXBhdGliaWxpdHkgcHVycG9zZXNcbiAgICAgIHBjLl9fbWVkaWFJRHMgPSB1bmRlZmluZWQ7XG4gICAgICBwYy5fX21lZGlhVHlwZXMgPSB1bmRlZmluZWQ7XG4gICAgfVxuXG4gICAgaWYgKFZBTElEX1JFU1BPTlNFX1NUQVRFUy5pbmRleE9mKHBjLnNpZ25hbGluZ1N0YXRlKSA+PSAwKSB7XG4gICAgICByZXR1cm4gdHEuY3JlYXRlQW5zd2VyKCk7XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gZW1pdFNkcCgpIHtcbiAgICB0cSgnc2RwLmxvY2FsJywgcGx1Y2tTZXNzaW9uRGVzYyh0aGlzLmFyZ3NbMF0pKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGVucXVldWUobmFtZSwgaGFuZGxlciwgb3B0cykge1xuICAgIHJldHVybiBmdW5jdGlvbigpIHtcbiAgICAgIHZhciBhcmdzID0gW10uc2xpY2UuY2FsbChhcmd1bWVudHMpO1xuXG4gICAgICBpZiAob3B0cyAmJiB0eXBlb2Ygb3B0cy5wcm9jZXNzQXJncyA9PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIGFyZ3MgPSBhcmdzLm1hcChvcHRzLnByb2Nlc3NBcmdzKTtcbiAgICAgIH1cblxuICAgICAgdmFyIHByaW9yaXR5ID0gcHJpb3JpdGllcy5pbmRleE9mKG5hbWUpO1xuXG4gICAgICByZXR1cm4gbmV3IFByb21pc2UoZnVuY3Rpb24ocmVzb2x2ZSwgcmVqZWN0KSB7XG4gICAgICAgICAgcXVldWUuZW5xKHtcbiAgICAgICAgICBhcmdzOiBhcmdzLFxuICAgICAgICAgIG5hbWU6IG5hbWUsXG4gICAgICAgICAgZm46IGhhbmRsZXIsXG4gICAgICAgICAgcHJpb3JpdHk6IHByaW9yaXR5ID49IDAgPyBwcmlvcml0eSA6IFBSSU9SSVRZX0xPVyxcbiAgICAgICAgICBpbW1lZGlhdGU6IG9wdHMuaW1tZWRpYXRlLFxuICAgICAgICAgIC8vIElmIGFib3J0ZWQsIHRoZSB0YXNrIHdpbGwgYmUgcmVtb3ZlZFxuICAgICAgICAgIGFib3J0ZWQ6IGZhbHNlLFxuXG4gICAgICAgICAgLy8gcmVjb3JkIHRoZSB0aW1lIGF0IHdoaWNoIHRoZSB0YXNrIHdhcyBxdWV1ZWRcbiAgICAgICAgICBzdGFydDogRGF0ZS5ub3coKSxcblxuICAgICAgICAgIC8vIGluaXRpbGFpc2UgYW55IGNoZWNrcyB0aGF0IG5lZWQgdG8gYmUgZG9uZSBwcmlvclxuICAgICAgICAgIC8vIHRvIHRoZSB0YXNrIGV4ZWN1dGluZ1xuICAgICAgICAgIGNoZWNrczogWyBpc05vdENsb3NlZCBdLmNvbmNhdCgob3B0cyB8fCB7fSkuY2hlY2tzIHx8IFtdKSxcblxuICAgICAgICAgIC8vIGluaXRpYWxpc2UgdGhlIHBhc3MgYW5kIGZhaWwgaGFuZGxlcnNcbiAgICAgICAgICBwYXNzOiBmdW5jdGlvbigpIHtcbiAgICAgICAgICAgIGlmIChvcHRzICYmIG9wdHMucGFzcykge1xuICAgICAgICAgICAgICBvcHRzLnBhc3MuYXBwbHkodGhpcywgYXJndW1lbnRzKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJlc29sdmUoKTtcbiAgICAgICAgICB9LFxuICAgICAgICAgIGZhaWw6IGZ1bmN0aW9uKCkge1xuICAgICAgICAgICAgaWYgKG9wdHMgJiYgb3B0cy5mYWlsKSB7XG4gICAgICAgICAgICAgIG9wdHMuZmFpbC5hcHBseSh0aGlzLCBhcmd1bWVudHMpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmVqZWN0KCk7XG4gICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICB0cmlnZ2VyUXVldWVDaGVjaygpO1xuICAgICAgfSk7XG4gICAgfTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGV4ZWNNZXRob2QodGFzaywgbmV4dCkge1xuICAgIHZhciBmbiA9IHBjW3Rhc2submFtZV07XG4gICAgdmFyIGV2ZW50TmFtZSA9IE1FVEhPRF9FVkVOVFNbdGFzay5uYW1lXSB8fCAodGFzay5uYW1lIHx8ICcnKS50b0xvd2VyQ2FzZSgpO1xuICAgIHZhciBjYkFyZ3MgPSBbIHN1Y2Nlc3MsIGZhaWwgXTtcbiAgICB2YXIgaXNPZmZlciA9IHRhc2submFtZSA9PT0gJ2NyZWF0ZU9mZmVyJztcblxuICAgIGZ1bmN0aW9uIGZhaWwoZXJyKSB7XG4gICAgICB0cS5hcHBseSh0cSwgWyAnbmVnb3RpYXRlLmVycm9yJywgdGFzay5uYW1lLCBlcnIgXS5jb25jYXQodGFzay5hcmdzKSk7XG4gICAgICBuZXh0KGVycik7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gc3VjY2VzcygpIHtcbiAgICAgIHRxLmFwcGx5KHRxLCBbIFsnbmVnb3RpYXRlJywgZXZlbnROYW1lLCAnb2snXSwgdGFzay5uYW1lIF0uY29uY2F0KHRhc2suYXJncykpO1xuICAgICAgbmV4dC5hcHBseShudWxsLCBbbnVsbF0uY29uY2F0KFtdLnNsaWNlLmNhbGwoYXJndW1lbnRzKSkpO1xuICAgIH1cblxuICAgIGlmICghIGZuKSB7XG4gICAgICByZXR1cm4gbmV4dChuZXcgRXJyb3IoJ2Nhbm5vdCBjYWxsIFwiJyArIHRhc2submFtZSArICdcIiBvbiBSVENQZWVyQ29ubmVjdGlvbicpKTtcbiAgICB9XG5cbiAgICAvLyBpbnZva2UgdGhlIGZ1bmN0aW9uXG4gICAgdHEuYXBwbHkodHEsIFsnbmVnb3RpYXRlLicgKyBldmVudE5hbWVdLmNvbmNhdCh0YXNrLmFyZ3MpKTtcbiAgICBmbi5hcHBseShcbiAgICAgIHBjLFxuICAgICAgdGFzay5hcmdzLmNvbmNhdChjYkFyZ3MpLmNvbmNhdChpc09mZmVyID8gZ2VuZXJhdGVDb25zdHJhaW50cygpIDogW10pXG4gICAgKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGV4cGlyZWQodGFzaykge1xuICAgIHJldHVybiAodHlwZW9mIHRhc2sudHRsID09ICdudW1iZXInKSAmJiAodGFzay5zdGFydCArIHRhc2sudHRsIDwgRGF0ZS5ub3coKSk7XG4gIH1cblxuICBmdW5jdGlvbiBhYm9ydGVkKHRhc2spIHtcbiAgICByZXR1cm4gdGFzayAmJiB0YXNrLmFib3J0ZWQ7XG4gIH1cblxuICBmdW5jdGlvbiBleHRyYWN0Q2FuZGlkYXRlRXZlbnREYXRhKGRhdGEpIHtcbiAgICAvLyBleHRyYWN0IG5lc3RlZCBjYW5kaWRhdGUgZGF0YSAobGlrZSB3ZSB3aWxsIHNlZSBpbiBhbiBldmVudCBiZWluZyBwYXNzZWQgdG8gdGhpcyBmdW5jdGlvbilcbiAgICB3aGlsZSAoZGF0YSAmJiBkYXRhLmNhbmRpZGF0ZSAmJiBkYXRhLmNhbmRpZGF0ZS5jYW5kaWRhdGUpIHtcbiAgICAgIGRhdGEgPSBkYXRhLmNhbmRpZGF0ZTtcbiAgICB9XG5cbiAgICByZXR1cm4gZGF0YTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGdlbmVyYXRlQ29uc3RyYWludHMoKSB7XG4gICAgdmFyIGFsbG93ZWRLZXlzID0ge1xuICAgICAgb2ZmZXJ0b3JlY2VpdmV2aWRlbzogJ09mZmVyVG9SZWNlaXZlVmlkZW8nLFxuICAgICAgb2ZmZXJ0b3JlY2VpdmVhdWRpbzogJ09mZmVyVG9SZWNlaXZlQXVkaW8nLFxuICAgICAgaWNlcmVzdGFydDogJ0ljZVJlc3RhcnQnLFxuICAgICAgdm9pY2VhY3Rpdml0eWRldGVjdGlvbjogJ1ZvaWNlQWN0aXZpdHlEZXRlY3Rpb24nXG4gICAgfTtcblxuICAgIHZhciBjb25zdHJhaW50cyA9IHtcbiAgICAgIE9mZmVyVG9SZWNlaXZlVmlkZW86IHRydWUsXG4gICAgICBPZmZlclRvUmVjZWl2ZUF1ZGlvOiB0cnVlXG4gICAgfTtcblxuICAgIC8vIEhhbmRsZSBtb3ppbGxhcyBzbGlnaHRseSBkaWZmZXJlbnQgY29uc3RyYWludCByZXF1aXJlbWVudHMgdGhhdCBhcmVcbiAgICAvLyBlbmZvcmNlZCBhcyBvZiBGRjQzXG4gICAgaWYgKGRldGVjdC5tb3opIHtcbiAgICAgIGFsbG93ZWRLZXlzID0ge1xuICAgICAgICBvZmZlcnRvcmVjZWl2ZXZpZGVvOiAnb2ZmZXJUb1JlY2VpdmVWaWRlbycsXG4gICAgICAgIG9mZmVydG9yZWNlaXZlYXVkaW86ICdvZmZlclRvUmVjZWl2ZUF1ZGlvJyxcbiAgICAgICAgaWNlcmVzdGFydDogJ2ljZVJlc3RhcnQnLFxuICAgICAgICB2b2ljZWFjdGl2aXR5ZGV0ZWN0aW9uOiAndm9pY2VBY3Rpdml0eURldGVjdGlvbidcbiAgICAgIH07XG4gICAgICBjb25zdHJhaW50cyA9IHtcbiAgICAgICAgb2ZmZXJUb1JlY2VpdmVWaWRlbzogdHJ1ZSxcbiAgICAgICAgb2ZmZXJUb1JlY2VpdmVBdWRpbzogdHJ1ZVxuICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyB1cGRhdGUga25vd24ga2V5cyB0byBtYXRjaFxuICAgIE9iamVjdC5rZXlzKG9wdHMgfHwge30pLmZvckVhY2goZnVuY3Rpb24oa2V5KSB7XG4gICAgICBpZiAoYWxsb3dlZEtleXNba2V5LnRvTG93ZXJDYXNlKCldKSB7XG4gICAgICAgIGNvbnN0cmFpbnRzW2FsbG93ZWRLZXlzW2tleS50b0xvd2VyQ2FzZSgpXV0gPSBvcHRzW2tleV07XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICByZXR1cm4gKGRldGVjdC5tb3ogPyBjb25zdHJhaW50cyA6IHsgbWFuZGF0b3J5OiBjb25zdHJhaW50cyB9KTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGhhc0xvY2FsT3JSZW1vdGVEZXNjKHBjLCB0YXNrKSB7XG4gICAgcmV0dXJuIHBjLl9faGFzRGVzYyB8fCAocGMuX19oYXNEZXNjID0gISFwYy5yZW1vdGVEZXNjcmlwdGlvbik7XG4gIH1cblxuICBmdW5jdGlvbiBpc05vdE5lZ290aWF0aW5nKHBjKSB7XG4gICAgcmV0dXJuIHBjLnNpZ25hbGluZ1N0YXRlICE9PSAnaGF2ZS1sb2NhbC1vZmZlcic7XG4gIH1cblxuICBmdW5jdGlvbiBpc05vdENsb3NlZChwYykge1xuICAgIHJldHVybiBwYy5zaWduYWxpbmdTdGF0ZSAhPT0gJ2Nsb3NlZCc7XG4gIH1cblxuICBmdW5jdGlvbiBpc1N0YWJsZShwYykge1xuICAgIHJldHVybiBwYy5zaWduYWxpbmdTdGF0ZSA9PT0gJ3N0YWJsZSc7XG4gIH1cblxuICBmdW5jdGlvbiBpc1ZhbGlkQ2FuZGlkYXRlKHBjLCBkYXRhKSB7XG4gICAgdmFyIHZhbGlkQ2FuZGlkYXRlID0gKGRhdGEuX192YWxpZCB8fFxuICAgICAgKGRhdGEuX192YWxpZCA9IGNoZWNrQ2FuZGlkYXRlKGRhdGEuYXJnc1swXSkubGVuZ3RoID09PSAwKSk7XG5cbiAgICAvLyBJZiB0aGUgY2FuZGlkYXRlIGlzIG5vdCB2YWxpZCwgYWJvcnRcbiAgICBpZiAoIXZhbGlkQ2FuZGlkYXRlKSB7XG4gICAgICBkYXRhLmFib3J0ZWQgPSB0cnVlO1xuICAgIH1cbiAgICByZXR1cm4gdmFsaWRDYW5kaWRhdGU7XG4gIH1cblxuICBmdW5jdGlvbiBpc0Nvbm5SZWFkeUZvckNhbmRpZGF0ZShwYywgZGF0YSkge1xuICAgIHZhciBzZHBNaWQgPSBkYXRhLmFyZ3NbMF0gJiYgZGF0YS5hcmdzWzBdLnNkcE1pZDtcblxuICAgIC8vIHJlbWFwIG1lZGlhIHR5cGVzIGFzIGFwcHJvcHJpYXRlXG4gICAgc2RwTWlkID0gTUVESUFfTUFQUElOR1Nbc2RwTWlkXSB8fCBzZHBNaWQ7XG5cbiAgICBpZiAoc2RwTWlkID09PSAnJylcbiAgICAgIHJldHVybiB0cnVlO1xuXG4gICAgLy8gQWxsb3cgcGFyc2luZyBvZiBTRFAgYWx3YXlzIGlmIHJlcXVpcmVkXG4gICAgaWYgKGFsd2F5c1BhcnNlIHx8ICFwYy5fX21lZGlhVHlwZXMpIHtcbiAgICAgIHZhciBzZHAgPSBwYXJzZVNkcChwYy5yZW1vdGVEZXNjcmlwdGlvbiAmJiBwYy5yZW1vdGVEZXNjcmlwdGlvbi5zZHApO1xuICAgICAgLy8gV2Ugb25seSB3YW50IHRvIGNhY2hlIHRoZSBTRFAgbWVkaWEgdHlwZXMgaWYgd2UndmUgcmVjZWl2ZWQgdGhlbSwgb3RoZXJ3aXNlXG4gICAgICAvLyBiYWQgdGhpbmdzIGNhbiBoYXBwZW5cbiAgICAgIHZhciBtZWRpYVR5cGVzID0gc2RwLmdldE1lZGlhVHlwZXMoKTtcbiAgICAgIGlmIChtZWRpYVR5cGVzICYmIG1lZGlhVHlwZXMubGVuZ3RoID4gMCkge1xuICAgICAgICBwYy5fX21lZGlhVHlwZXMgPSBtZWRpYVR5cGVzO1xuICAgICAgfVxuICAgICAgLy8gU2FtZSBmb3IgbWVkaWEgSURzXG4gICAgICB2YXIgbWVkaWFJRHMgPSBzZHAuZ2V0TWVkaWFJRHMoKTtcbiAgICAgIGlmIChtZWRpYUlEcyAmJiBtZWRpYUlEcy5sZW5ndGggPiAwKSB7XG4gICAgICAgIHBjLl9fbWVkaWFJRHMgPSBtZWRpYUlEcztcbiAgICAgIH1cbiAgICB9XG4gICAgLy8gdGhlIGNhbmRpZGF0ZSBpcyB2YWxpZCBpZiB0aGUgc2RwTWlkIG1hdGNoZXMgZWl0aGVyIGEga25vd24gbWVkaWFcbiAgICAvLyB0eXBlLCBvciBtZWRpYSBJRFxuICAgIHZhciB2YWxpZE1lZGlhQ2FuZGlkYXRlID1cbiAgICAgIChwYy5fX21lZGlhSURzICYmIHBjLl9fbWVkaWFJRHMuaW5kZXhPZihzZHBNaWQpID49IDApIHx8XG4gICAgICAocGMuX19tZWRpYVR5cGVzICYmIHBjLl9fbWVkaWFUeXBlcy5pbmRleE9mKHNkcE1pZCkgPj0gMCk7XG5cbiAgICAvLyBPdGhlcndpc2Ugd2UgYWJvcnQgdGhlIHRhc2tcbiAgICBpZiAoIXZhbGlkTWVkaWFDYW5kaWRhdGUpIHtcbiAgICAgIGRhdGEuYWJvcnRlZCA9IHRydWU7XG4gICAgfVxuICAgIHJldHVybiB2YWxpZE1lZGlhQ2FuZGlkYXRlO1xuICB9XG5cbiAgZnVuY3Rpb24gb3JkZXJUYXNrcyhhLCBiKSB7XG4gICAgLy8gYXBwbHkgZWFjaCBvZiB0aGUgY2hlY2tzIGZvciBlYWNoIHRhc2tcbiAgICB2YXIgdGFza3MgPSBbYSxiXTtcbiAgICB2YXIgcmVhZGluZXNzID0gdGFza3MubWFwKHRlc3RSZWFkeSk7XG4gICAgdmFyIHRhc2tQcmlvcml0aWVzID0gdGFza3MubWFwKGZ1bmN0aW9uKHRhc2ssIGlkeCkge1xuICAgICAgdmFyIHJlYWR5ID0gcmVhZGluZXNzW2lkeF07XG4gICAgICByZXR1cm4gcmVhZHkgPyB0YXNrLnByaW9yaXR5IDogUFJJT1JJVFlfV0FJVDtcbiAgICB9KTtcblxuICAgIHJldHVybiB0YXNrUHJpb3JpdGllc1sxXSAtIHRhc2tQcmlvcml0aWVzWzBdO1xuICB9XG5cbiAgLy8gY2hlY2sgd2hldGhlciBhIHRhc2sgaXMgcmVhZHkgKGRvZXMgaXQgcGFzcyBhbGwgdGhlIGNoZWNrcylcbiAgZnVuY3Rpb24gdGVzdFJlYWR5KHRhc2spIHtcbiAgICByZXR1cm4gKHRhc2suY2hlY2tzIHx8IFtdKS5yZWR1Y2UoZnVuY3Rpb24obWVtbywgY2hlY2spIHtcbiAgICAgIHJldHVybiBtZW1vICYmIGNoZWNrKHBjLCB0YXNrKTtcbiAgICB9LCB0cnVlKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIHRyaWdnZXJRdWV1ZUNoZWNrKCkge1xuICAgIGlmIChjaGVja1F1ZXVlVGltZXIpIHJldHVybjtcbiAgICBjaGVja1F1ZXVlVGltZXIgPSBzZXRUaW1lb3V0KGNoZWNrUXVldWUsIHF1ZXVlSW50ZXJ2YWwpO1xuICB9XG5cbiAgLy8gcGF0Y2ggaW4gdGhlIHF1ZXVlIGhlbHBlciBtZXRob2RzXG4gIHRxLmFkZEljZUNhbmRpZGF0ZSA9IGVucXVldWUoJ2FkZEljZUNhbmRpZGF0ZScsIGFwcGx5Q2FuZGlkYXRlLCB7XG4gICAgcHJvY2Vzc0FyZ3M6IGV4dHJhY3RDYW5kaWRhdGVFdmVudERhdGEsXG4gICAgY2hlY2tzOiBbaGFzTG9jYWxPclJlbW90ZURlc2MsIGlzVmFsaWRDYW5kaWRhdGUsIGlzQ29ublJlYWR5Rm9yQ2FuZGlkYXRlIF0sXG5cbiAgICAvLyBzZXQgdHRsIHRvIDVzXG4gICAgdHRsOiA1MDAwLFxuICAgIGltbWVkaWF0ZTogdHJ1ZVxuICB9KTtcblxuICB0cS5zZXRMb2NhbERlc2NyaXB0aW9uID0gZW5xdWV1ZSgnc2V0TG9jYWxEZXNjcmlwdGlvbicsIGV4ZWNNZXRob2QsIHtcbiAgICBwcm9jZXNzQXJnczogY2xlYW5zZHAsXG4gICAgcGFzczogZW1pdFNkcFxuICB9KTtcblxuICB0cS5zZXRSZW1vdGVEZXNjcmlwdGlvbiA9IGVucXVldWUoJ3NldFJlbW90ZURlc2NyaXB0aW9uJywgZXhlY01ldGhvZCwge1xuICAgIHByb2Nlc3NBcmdzOiBjcmVhdGVTZXNzaW9uRGVzY3JpcHRpb24sXG4gICAgcGFzczogY29tcGxldGVDb25uZWN0aW9uXG4gIH0pO1xuXG4gIHRxLmNyZWF0ZU9mZmVyID0gZW5xdWV1ZSgnY3JlYXRlT2ZmZXInLCBleGVjTWV0aG9kLCB7XG4gICAgY2hlY2tzOiBbIGlzTm90TmVnb3RpYXRpbmcgXSxcbiAgICBwYXNzOiB0cS5zZXRMb2NhbERlc2NyaXB0aW9uXG4gIH0pO1xuXG4gIHRxLmNyZWF0ZUFuc3dlciA9IGVucXVldWUoJ2NyZWF0ZUFuc3dlcicsIGV4ZWNNZXRob2QsIHtcbiAgICBwYXNzOiB0cS5zZXRMb2NhbERlc2NyaXB0aW9uXG4gIH0pO1xuXG4gIHJldHVybiB0cTtcbn07XG4iLCIvKiBqc2hpbnQgbm9kZTogdHJ1ZSAqL1xuJ3VzZSBzdHJpY3QnO1xuXG52YXIgZGVidWcgPSByZXF1aXJlKCdjb2cvbG9nZ2VyJykoJ3J0Yy9jbGVhbnVwJyk7XG5cbnZhciBDQU5OT1RfQ0xPU0VfU1RBVEVTID0gW1xuICAnY2xvc2VkJ1xuXTtcblxudmFyIEVWRU5UU19ERUNPVVBMRV9CQyA9IFtcbiAgJ2FkZHN0cmVhbScsXG4gICdkYXRhY2hhbm5lbCcsXG4gICdpY2VjYW5kaWRhdGUnLFxuICAnbmVnb3RpYXRpb25uZWVkZWQnLFxuICAncmVtb3Zlc3RyZWFtJyxcbiAgJ3NpZ25hbGluZ3N0YXRlY2hhbmdlJ1xuXTtcblxudmFyIEVWRU5UU19ERUNPVVBMRV9BQyA9IFtcbiAgJ2ljZWNvbm5lY3Rpb25zdGF0ZWNoYW5nZSdcbl07XG5cbi8qKlxuICAjIyMgcnRjLXRvb2xzL2NsZWFudXBcblxuICBgYGBcbiAgY2xlYW51cChwYylcbiAgYGBgXG5cbiAgVGhlIGBjbGVhbnVwYCBmdW5jdGlvbiBpcyB1c2VkIHRvIGVuc3VyZSB0aGF0IGEgcGVlciBjb25uZWN0aW9uIGlzIHByb3Blcmx5XG4gIGNsb3NlZCBhbmQgcmVhZHkgdG8gYmUgY2xlYW5lZCB1cCBieSB0aGUgYnJvd3Nlci5cblxuKiovXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKHBjKSB7XG4gIGlmICghcGMpIHJldHVybjtcblxuICAvLyBzZWUgaWYgd2UgY2FuIGNsb3NlIHRoZSBjb25uZWN0aW9uXG4gIHZhciBjdXJyZW50U3RhdGUgPSBwYy5pY2VDb25uZWN0aW9uU3RhdGU7XG4gIHZhciBjdXJyZW50U2lnbmFsaW5nID0gcGMuc2lnbmFsaW5nU3RhdGU7XG4gIHZhciBjYW5DbG9zZSA9IENBTk5PVF9DTE9TRV9TVEFURVMuaW5kZXhPZihjdXJyZW50U3RhdGUpIDwgMCAmJiBDQU5OT1RfQ0xPU0VfU1RBVEVTLmluZGV4T2YoY3VycmVudFNpZ25hbGluZykgPCAwO1xuXG4gIGZ1bmN0aW9uIGRlY291cGxlKGV2ZW50cykge1xuICAgIGV2ZW50cy5mb3JFYWNoKGZ1bmN0aW9uKGV2dE5hbWUpIHtcbiAgICAgIGlmIChwY1snb24nICsgZXZ0TmFtZV0pIHtcbiAgICAgICAgcGNbJ29uJyArIGV2dE5hbWVdID0gbnVsbDtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxuXG4gIC8vIGRlY291cGxlIFwiYmVmb3JlIGNsb3NlXCIgZXZlbnRzXG4gIGRlY291cGxlKEVWRU5UU19ERUNPVVBMRV9CQyk7XG5cbiAgaWYgKGNhbkNsb3NlKSB7XG4gICAgZGVidWcoJ2F0dGVtcHRpbmcgY29ubmVjdGlvbiBjbG9zZSwgY3VycmVudCBzdGF0ZTogJysgcGMuaWNlQ29ubmVjdGlvblN0YXRlKTtcbiAgICB0cnkge1xuICAgICAgcGMuY2xvc2UoKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zb2xlLndhcm4oJ0NvdWxkIG5vdCBjbG9zZSBjb25uZWN0aW9uJywgZSk7XG4gICAgfVxuICB9XG5cbiAgLy8gcmVtb3ZlIHRoZSBldmVudCBsaXN0ZW5lcnNcbiAgLy8gYWZ0ZXIgYSBzaG9ydCBkZWxheSBnaXZpbmcgdGhlIGNvbm5lY3Rpb24gdGltZSB0byB0cmlnZ2VyXG4gIC8vIGNsb3NlIGFuZCBpY2Vjb25uZWN0aW9uc3RhdGVjaGFuZ2UgZXZlbnRzXG4gIHNldFRpbWVvdXQoZnVuY3Rpb24oKSB7XG4gICAgZGVjb3VwbGUoRVZFTlRTX0RFQ09VUExFX0FDKTtcbiAgfSwgMTAwKTtcbn07XG4iLCIvKiBqc2hpbnQgbm9kZTogdHJ1ZSAqL1xuJ3VzZSBzdHJpY3QnO1xuXG52YXIgbWJ1cyA9IHJlcXVpcmUoJ21idXMnKTtcbnZhciBxdWV1ZSA9IHJlcXVpcmUoJ3J0Yy10YXNrcXVldWUnKTtcbnZhciBjbGVhbnVwID0gcmVxdWlyZSgnLi9jbGVhbnVwJyk7XG52YXIgbW9uaXRvciA9IHJlcXVpcmUoJy4vbW9uaXRvcicpO1xudmFyIHRocm90dGxlID0gcmVxdWlyZSgnY29nL3Rocm90dGxlJyk7XG52YXIgcGx1Y2sgPSByZXF1aXJlKCd3aGlzay9wbHVjaycpO1xudmFyIHBsdWNrQ2FuZGlkYXRlID0gcGx1Y2soJ2NhbmRpZGF0ZScsICdzZHBNaWQnLCAnc2RwTUxpbmVJbmRleCcpO1xudmFyIENMT1NFRF9TVEFURVMgPSBbICdjbG9zZWQnLCAnZmFpbGVkJyBdO1xudmFyIENIRUNLSU5HX1NUQVRFUyA9IFsgJ2NoZWNraW5nJyBdO1xuXG4vKipcbiAgIyMjIHJ0Yy10b29scy9jb3VwbGVcblxuICAjIyMjIGNvdXBsZShwYywgdGFyZ2V0SWQsIHNpZ25hbGxlciwgb3B0cz8pXG5cbiAgQ291cGxlIGEgV2ViUlRDIGNvbm5lY3Rpb24gd2l0aCBhbm90aGVyIHdlYnJ0YyBjb25uZWN0aW9uIGlkZW50aWZpZWQgYnlcbiAgYHRhcmdldElkYCB2aWEgdGhlIHNpZ25hbGxlci5cblxuICBUaGUgZm9sbG93aW5nIG9wdGlvbnMgY2FuIGJlIHByb3ZpZGVkIGluIHRoZSBgb3B0c2AgYXJndW1lbnQ6XG5cbiAgLSBgc2RwZmlsdGVyYCAoZGVmYXVsdDogbnVsbClcblxuICAgIEEgc2ltcGxlIGZ1bmN0aW9uIGZvciBmaWx0ZXJpbmcgU0RQIGFzIHBhcnQgb2YgdGhlIHBlZXJcbiAgICBjb25uZWN0aW9uIGhhbmRzaGFrZSAoc2VlIHRoZSBVc2luZyBGaWx0ZXJzIGRldGFpbHMgYmVsb3cpLlxuXG4gICMjIyMjIEV4YW1wbGUgVXNhZ2VcblxuICBgYGBqc1xuICB2YXIgY291cGxlID0gcmVxdWlyZSgncnRjL2NvdXBsZScpO1xuXG4gIGNvdXBsZShwYywgJzU0ODc5OTY1LWNlNDMtNDI2ZS1hOGVmLTA5YWMxZTM5YTE2ZCcsIHNpZ25hbGxlcik7XG4gIGBgYFxuXG4gICMjIyMjIFVzaW5nIEZpbHRlcnNcblxuICBJbiBjZXJ0YWluIGluc3RhbmNlcyB5b3UgbWF5IHdpc2ggdG8gbW9kaWZ5IHRoZSByYXcgU0RQIHRoYXQgaXMgcHJvdmlkZWRcbiAgYnkgdGhlIGBjcmVhdGVPZmZlcmAgYW5kIGBjcmVhdGVBbnN3ZXJgIGNhbGxzLiAgVGhpcyBjYW4gYmUgZG9uZSBieSBwYXNzaW5nXG4gIGEgYHNkcGZpbHRlcmAgZnVuY3Rpb24gKG9yIGFycmF5KSBpbiB0aGUgb3B0aW9ucy4gIEZvciBleGFtcGxlOlxuXG4gIGBgYGpzXG4gIC8vIHJ1biB0aGUgc2RwIGZyb20gdGhyb3VnaCBhIGxvY2FsIHR3ZWFrU2RwIGZ1bmN0aW9uLlxuICBjb3VwbGUocGMsICc1NDg3OTk2NS1jZTQzLTQyNmUtYThlZi0wOWFjMWUzOWExNmQnLCBzaWduYWxsZXIsIHtcbiAgICBzZHBmaWx0ZXI6IHR3ZWFrU2RwXG4gIH0pO1xuICBgYGBcblxuKiovXG5mdW5jdGlvbiBjb3VwbGUocGMsIHRhcmdldElkLCBzaWduYWxsZXIsIG9wdHMpIHtcbiAgdmFyIGRlYnVnTGFiZWwgPSAob3B0cyB8fCB7fSkuZGVidWdMYWJlbCB8fCAncnRjJztcbiAgdmFyIGRlYnVnID0gcmVxdWlyZSgnY29nL2xvZ2dlcicpKGRlYnVnTGFiZWwgKyAnL2NvdXBsZScpO1xuXG4gIC8vIGNyZWF0ZSBhIG1vbml0b3IgZm9yIHRoZSBjb25uZWN0aW9uXG4gIHZhciBtb24gPSBtb25pdG9yKHBjLCB0YXJnZXRJZCwgc2lnbmFsbGVyLCAob3B0cyB8fCB7fSkubG9nZ2VyKTtcbiAgdmFyIGVtaXQgPSBtYnVzKCcnLCBtb24pO1xuICB2YXIgcmVhY3RpdmUgPSAob3B0cyB8fCB7fSkucmVhY3RpdmU7XG4gIHZhciBlbmRPZkNhbmRpZGF0ZXMgPSB0cnVlO1xuXG4gIC8vIGNvbmZpZ3VyZSB0aGUgdGltZSB0byB3YWl0IGJldHdlZW4gcmVjZWl2aW5nIGEgJ2Rpc2Nvbm5lY3QnXG4gIC8vIGljZUNvbm5lY3Rpb25TdGF0ZSBhbmQgZGV0ZXJtaW5pbmcgdGhhdCB3ZSBhcmUgY2xvc2VkXG4gIHZhciBkaXNjb25uZWN0VGltZW91dCA9IChvcHRzIHx8IHt9KS5kaXNjb25uZWN0VGltZW91dCB8fCAxMDAwMDtcbiAgdmFyIGRpc2Nvbm5lY3RUaW1lcjtcblxuICAvLyBUYXJnZXQgcmVhZHkgaW5kaWNhdGVzIHRoYXQgdGhlIHRhcmdldCBwZWVyIGhhcyBpbmRpY2F0ZWQgaXQgaXNcbiAgLy8gcmVhZHkgdG8gYmVnaW4gY291cGxpbmdcbiAgdmFyIHRhcmdldFJlYWR5ID0gZmFsc2U7XG4gIHZhciB0YXJnZXRJbmZvID0gdW5kZWZpbmVkO1xuICB2YXIgcmVhZHlJbnRlcnZhbCA9IChvcHRzIHx8IHt9KS5yZWFkeUludGVydmFsIHx8IDEwMDtcbiAgdmFyIHJlYWR5VGltZXI7XG5cbiAgLy8gRmFpbHVyZSB0aW1lb3V0XG4gIHZhciBmYWlsVGltZW91dCA9IChvcHRzIHx8IHt9KS5mYWlsVGltZW91dCB8fCAzMDAwMDtcbiAgdmFyIGZhaWxUaW1lcjtcblxuICAvLyBSZXF1ZXN0IG9mZmVyIHRpbWVyXG4gIHZhciByZXF1ZXN0T2ZmZXJUaW1lcjtcblxuICAvLyBJbnRlcm9wZXJhYmlsaXR5IGZsYWdzXG4gIHZhciBhbGxvd1JlYWN0aXZlSW50ZXJvcCA9IChvcHRzIHx8IHt9KS5hbGxvd1JlYWN0aXZlSW50ZXJvcDtcblxuICAvLyBpbml0aWxhaXNlIHRoZSBuZWdvdGlhdGlvbiBoZWxwZXJzXG4gIHZhciBpc01hc3RlciA9IHNpZ25hbGxlci5pc01hc3Rlcih0YXJnZXRJZCk7XG5cbiAgLy8gaW5pdGlhbGlzZSB0aGUgcHJvY2Vzc2luZyBxdWV1ZSAob25lIGF0IGEgdGltZSBwbGVhc2UpXG4gIHZhciBxID0gcXVldWUocGMsIG9wdHMpO1xuICB2YXIgY291cGxpbmcgPSBmYWxzZTtcbiAgdmFyIG5lZ290aWF0aW9uUmVxdWlyZWQgPSBmYWxzZTtcbiAgdmFyIHJlbmVnb3RpYXRlUmVxdWlyZWQgPSBmYWxzZTtcbiAgdmFyIGNyZWF0aW5nT2ZmZXIgPSBmYWxzZTtcbiAgdmFyIGludGVyb3BlcmF0aW5nID0gZmFsc2U7XG5cbiAgLyoqXG4gICAgSW5kaWNhdGVzIHdoZXRoZXIgdGhpcyBwZWVyIGNvbm5lY3Rpb24gaXMgaW4gYSBzdGF0ZSB3aGVyZSBpdCBpcyBhYmxlIHRvIGhhdmUgbmV3IG9mZmVycyBjcmVhdGVkXG4gICAqKi9cbiAgZnVuY3Rpb24gaXNSZWFkeUZvck9mZmVyKCkge1xuICAgIHJldHVybiAhY291cGxpbmcgJiYgcGMuc2lnbmFsaW5nU3RhdGUgPT09ICdzdGFibGUnO1xuICB9XG5cbiAgZnVuY3Rpb24gY3JlYXRlT2ZmZXIoKSB7XG4gICAgLy8gSWYgY291cGxpbmcgaXMgYWxyZWFkeSBpbiBwcm9ncmVzcywgcmV0dXJuXG4gICAgaWYgKCFpc1JlYWR5Rm9yT2ZmZXIoKSkgcmV0dXJuO1xuXG4gICAgZGVidWcoJ1snICsgc2lnbmFsbGVyLmlkICsgJ10gJyArICdDcmVhdGluZyBuZXcgb2ZmZXIgZm9yIGNvbm5lY3Rpb24gdG8gJyArIHRhcmdldElkKTtcbiAgICAvLyBPdGhlcndpc2UsIGNyZWF0ZSB0aGUgb2ZmZXJcbiAgICBjb3VwbGluZyA9IHRydWU7XG4gICAgY3JlYXRpbmdPZmZlciA9IHRydWU7XG4gICAgbmVnb3RpYXRpb25SZXF1aXJlZCA9IGZhbHNlO1xuICAgIHEuY3JlYXRlT2ZmZXIoKS50aGVuKGZ1bmN0aW9uKCkge1xuICAgICAgY3JlYXRpbmdPZmZlciA9IGZhbHNlO1xuICAgIH0pLmNhdGNoKGZ1bmN0aW9uKCkge1xuICAgICAgY3JlYXRpbmdPZmZlciA9IGZhbHNlO1xuICAgIH0pO1xuICB9XG5cbiAgdmFyIGNyZWF0ZU9yUmVxdWVzdE9mZmVyID0gdGhyb3R0bGUoZnVuY3Rpb24oKSB7XG4gICAgaWYgKCF0YXJnZXRSZWFkeSkge1xuICAgICAgZGVidWcoJ1snICsgc2lnbmFsbGVyLmlkICsgJ10gJyArIHRhcmdldElkICsgJyBub3QgeWV0IHJlYWR5IGZvciBvZmZlcicpO1xuICAgICAgcmV0dXJuIGVtaXQub25jZSgndGFyZ2V0LnJlYWR5JywgY3JlYXRlT3JSZXF1ZXN0T2ZmZXIpO1xuICAgIH1cblxuICAgIC8vIElmIHRoaXMgaXMgbm90IHRoZSBtYXN0ZXIsIGFsd2F5cyBzZW5kIHRoZSBuZWdvdGlhdGUgcmVxdWVzdFxuICAgIC8vIFJlZHVuZGFudCByZXF1ZXN0cyBhcmUgZWxpbWluYXRlZCBvbiB0aGUgbWFzdGVyIHNpZGVcbiAgICBpZiAoISBpc01hc3Rlcikge1xuICAgICAgZGVidWcoJ1snICsgc2lnbmFsbGVyLmlkICsgJ10gJyArICdSZXF1ZXN0aW5nIG5lZ290aWF0aW9uIGZyb20gJyArIHRhcmdldElkICsgJyAocmVxdWVzdGluZyBvZmZlcmVyPyAnICsgcmVuZWdvdGlhdGVSZXF1aXJlZCArICcpJyk7XG4gICAgICAvLyBEdWUgdG8gaHR0cHM6Ly9idWdzLmNocm9taXVtLm9yZy9wL3dlYnJ0Yy9pc3N1ZXMvZGV0YWlsP2lkPTI3ODIgd2hpY2ggaW52b2x2ZXMgaW5jb21wYXRpYmlsaXRpZXMgYmV0d2VlblxuICAgICAgLy8gQ2hyb21lIGFuZCBGaXJlZm94IGNyZWF0ZWQgb2ZmZXJzIGJ5IGRlZmF1bHQgY2xpZW50IG9mZmVycyBhcmUgZGlzYWJsZWQgdG8gZW5zdXJlIHRoYXQgYWxsIG9mZmVycyBhcmUgY29taW5nXG4gICAgICAvLyBmcm9tIHRoZSBzYW1lIHNvdXJjZS4gQnkgcGFzc2luZyBgYWxsb3dSZWFjdGl2ZUludGVyb3BgIHlvdSBjYW4gcmVhbGxvdyB0aGlzLCB0aGVuIHVzZSB0aGUgYGZpbHRlcnNkcGAgb3B0aW9uXG4gICAgICAvLyB0byBwcm92aWRlIGEgbXVuZ2VkIFNEUCB0aGF0IG1pZ2h0IGJlIGFibGUgdG8gd29ya1xuICAgICAgcmV0dXJuIHNpZ25hbGxlci50byh0YXJnZXRJZCkuc2VuZCgnL25lZ290aWF0ZScsIHtcbiAgICAgICAgcmVxdWVzdE9mZmVyZXI6IChhbGxvd1JlYWN0aXZlSW50ZXJvcCB8fCAhaW50ZXJvcGVyYXRpbmcpICYmIHJlbmVnb3RpYXRlUmVxdWlyZWRcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIHJldHVybiBjcmVhdGVPZmZlcigpO1xuICB9LCAxMDAsIHsgbGVhZGluZzogZmFsc2UgfSk7XG5cbiAgZnVuY3Rpb24gZGVjb3VwbGUoKSB7XG4gICAgZGVidWcoJ2RlY291cGxpbmcgJyArIHNpZ25hbGxlci5pZCArICcgZnJvbSAnICsgdGFyZ2V0SWQpO1xuXG4gICAgLy8gQ2xlYXIgYW55IG91dHN0YW5kaW5nIHRpbWVyc1xuICAgIGNsZWFyVGltZW91dChyZWFkeVRpbWVyKTtcbiAgICBjbGVhclRpbWVvdXQoZGlzY29ubmVjdFRpbWVyKTtcbiAgICBjbGVhclRpbWVvdXQocmVxdWVzdE9mZmVyVGltZXIpO1xuICAgIGNsZWFyVGltZW91dChmYWlsVGltZXIpO1xuXG4gICAgLy8gc3RvcCB0aGUgbW9uaXRvclxuLy8gICAgIG1vbi5yZW1vdmVBbGxMaXN0ZW5lcnMoKTtcbiAgICBtb24uY2xvc2UoKTtcblxuICAgIC8vIGNsZWFudXAgdGhlIHBlZXJjb25uZWN0aW9uXG4gICAgY2xlYW51cChwYyk7XG5cbiAgICAvLyByZW1vdmUgbGlzdGVuZXJzXG4gICAgc2lnbmFsbGVyLnJlbW92ZUxpc3RlbmVyKCdzZHAnLCBoYW5kbGVTZHApO1xuICAgIHNpZ25hbGxlci5yZW1vdmVMaXN0ZW5lcignY2FuZGlkYXRlJywgaGFuZGxlQ2FuZGlkYXRlKTtcbiAgICBzaWduYWxsZXIucmVtb3ZlTGlzdGVuZXIoJ2VuZG9mY2FuZGlkYXRlcycsIGhhbmRsZUxhc3RDYW5kaWRhdGUpO1xuICAgIHNpZ25hbGxlci5yZW1vdmVMaXN0ZW5lcignbmVnb3RpYXRlJywgaGFuZGxlTmVnb3RpYXRlUmVxdWVzdCk7XG4gICAgc2lnbmFsbGVyLnJlbW92ZUxpc3RlbmVyKCdyZWFkeScsIGhhbmRsZVJlYWR5KTtcbiAgICBzaWduYWxsZXIucmVtb3ZlTGlzdGVuZXIoJ3JlcXVlc3RvZmZlcicsIGhhbmRsZVJlcXVlc3RPZmZlcik7XG5cbiAgICAvLyByZW1vdmUgbGlzdGVuZXJzICh2ZXJzaW9uID49IDUpXG4gICAgc2lnbmFsbGVyLnJlbW92ZUxpc3RlbmVyKCdtZXNzYWdlOnNkcCcsIGhhbmRsZVNkcCk7XG4gICAgc2lnbmFsbGVyLnJlbW92ZUxpc3RlbmVyKCdtZXNzYWdlOmNhbmRpZGF0ZScsIGhhbmRsZUNhbmRpZGF0ZSk7XG4gICAgc2lnbmFsbGVyLnJlbW92ZUxpc3RlbmVyKCdtZXNzYWdlOmVuZG9mY2FuZGlkYXRlcycsIGhhbmRsZUxhc3RDYW5kaWRhdGUpO1xuICAgIHNpZ25hbGxlci5yZW1vdmVMaXN0ZW5lcignbWVzc2FnZTpuZWdvdGlhdGUnLCBoYW5kbGVOZWdvdGlhdGVSZXF1ZXN0KTtcbiAgICBzaWduYWxsZXIucmVtb3ZlTGlzdGVuZXIoJ21lc3NhZ2U6cmVhZHknLCBoYW5kbGVSZWFkeSk7XG4gICAgc2lnbmFsbGVyLnJlbW92ZUxpc3RlbmVyKCdtZXNzYWdlOnJlcXVlc3RvZmZlcicsIGhhbmRsZVJlcXVlc3RPZmZlcik7XG5cbiAgfVxuXG4gIGZ1bmN0aW9uIGhhbmRsZUNhbmRpZGF0ZShkYXRhLCBzcmMpIHtcbiAgICAvLyBpZiB0aGUgc291cmNlIGlzIHVua25vd24gb3Igbm90IGEgbWF0Y2gsIHRoZW4gZG9uJ3QgcHJvY2Vzc1xuICAgIGlmICgoISBzcmMpIHx8IChzcmMuaWQgIT09IHRhcmdldElkKSkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIHEuYWRkSWNlQ2FuZGlkYXRlKGRhdGEpO1xuICB9XG5cbiAgLy8gTm8gb3BcbiAgZnVuY3Rpb24gaGFuZGxlTGFzdENhbmRpZGF0ZSgpIHtcbiAgfVxuXG4gIGZ1bmN0aW9uIGhhbmRsZVNkcChzZHAsIHNyYykge1xuICAgIC8vIGlmIHRoZSBzb3VyY2UgaXMgdW5rbm93biBvciBub3QgYSBtYXRjaCwgdGhlbiBkb24ndCBwcm9jZXNzXG4gICAgaWYgKCghIHNyYykgfHwgKHNyYy5pZCAhPT0gdGFyZ2V0SWQpKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgZW1pdCgnc2RwLnJlbW90ZScsIHNkcCk7XG5cbiAgICAvLyBUbyBzcGVlZCB1cCB0aGluZ3Mgb24gdGhlIHJlbmVnb3RpYXRpb24gc2lkZSBvZiB0aGluZ3MsIGRldGVybWluZSB3aGV0aGVyIHdlIGhhdmVcbiAgICAvLyBmaW5pc2hlZCB0aGUgY291cGxpbmcgKG9mZmVyIC0+IGFuc3dlcikgY3ljbGUsIGFuZCB3aGV0aGVyIGl0IGlzIHNhZmUgdG8gc3RhcnRcbiAgICAvLyByZW5lZ290aWF0aW5nIHByaW9yIHRvIHRoZSBpY2VDb25uZWN0aW9uU3RhdGUgXCJjb21wbGV0ZWRcIiBzdGF0ZVxuICAgIHEuc2V0UmVtb3RlRGVzY3JpcHRpb24oc2RwKS50aGVuKGZ1bmN0aW9uKCkge1xuXG4gICAgICAvLyBJZiB0aGlzIGlzIHRoZSBwZWVyIHRoYXQgaXMgY291cGxpbmcsIGFuZCB3ZSBoYXZlIHJlY2VpdmVkIHRoZSBhbnN3ZXIgc28gd2UgY2FuXG4gICAgICAvLyBhbmQgYXNzdW1lIHRoYXQgY291cGxpbmcgKG9mZmVyIC0+IGFuc3dlcikgcHJvY2VzcyBpcyBjb21wbGV0ZSwgc28gd2UgY2FuIGNsZWFyIHRoZSBjb3VwbGluZyBmbGFnXG4gICAgICBpZiAoY291cGxpbmcgJiYgc2RwLnR5cGUgPT09ICdhbnN3ZXInKSB7XG4gICAgICAgIGRlYnVnKCdjb3VwbGluZyBjb21wbGV0ZSwgY2FuIG5vdyB0cmlnZ2VyIGFueSBwZW5kaW5nIHJlbmVnb3RpYXRpb25zJyk7XG4gICAgICAgIGlmIChpc01hc3RlciAmJiBuZWdvdGlhdGlvblJlcXVpcmVkKSBjcmVhdGVPclJlcXVlc3RPZmZlcigpO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG5cbiAgZnVuY3Rpb24gaGFuZGxlUmVhZHkoc3JjKSB7XG4gICAgaWYgKHRhcmdldFJlYWR5IHx8ICFzcmMgfHwgc3JjLmlkICE9PSB0YXJnZXRJZCkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBkZWJ1ZygnWycgKyBzaWduYWxsZXIuaWQgKyAnXSAnICsgdGFyZ2V0SWQgKyAnIGlzIHJlYWR5IGZvciBjb3VwbGluZycpO1xuICAgIHRhcmdldFJlYWR5ID0gdHJ1ZTtcbiAgICB0YXJnZXRJbmZvID0gc3JjLmRhdGE7XG4gICAgaW50ZXJvcGVyYXRpbmcgPSAodGFyZ2V0SW5mby5icm93c2VyICE9PSBzaWduYWxsZXIuYXR0cmlidXRlcy5icm93c2VyKTtcbiAgICBlbWl0KCd0YXJnZXQucmVhZHknKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGhhbmRsZUNvbm5lY3Rpb25DbG9zZSgpIHtcbiAgICBkZWJ1ZygnY2FwdHVyZWQgcGMgY2xvc2UsIGljZUNvbm5lY3Rpb25TdGF0ZSA9ICcgKyBwYy5pY2VDb25uZWN0aW9uU3RhdGUpO1xuICAgIGRlY291cGxlKCk7XG4gIH1cblxuICBmdW5jdGlvbiBoYW5kbGVEaXNjb25uZWN0KCkge1xuICAgIGRlYnVnKCdjYXB0dXJlZCBwYyBkaXNjb25uZWN0LCBtb25pdG9yaW5nIGNvbm5lY3Rpb24gc3RhdHVzJyk7XG5cbiAgICAvLyBzdGFydCB0aGUgZGlzY29ubmVjdCB0aW1lclxuICAgIGRpc2Nvbm5lY3RUaW1lciA9IHNldFRpbWVvdXQoZnVuY3Rpb24oKSB7XG4gICAgICBkZWJ1ZygnbWFudWFsbHkgY2xvc2luZyBjb25uZWN0aW9uIGFmdGVyIGRpc2Nvbm5lY3QgdGltZW91dCcpO1xuICAgICAgbW9uKCdmYWlsZWQnKTtcbiAgICAgIGNsZWFudXAocGMpO1xuICAgIH0sIGRpc2Nvbm5lY3RUaW1lb3V0KTtcblxuICAgIG1vbi5vbignc3RhdGVjaGFuZ2UnLCBoYW5kbGVEaXNjb25uZWN0QWJvcnQpO1xuICAgIG1vbignZmFpbGluZycpO1xuICB9XG5cbiAgZnVuY3Rpb24gaGFuZGxlRGlzY29ubmVjdEFib3J0KCkge1xuICAgIGRlYnVnKCdjb25uZWN0aW9uIHN0YXRlIGNoYW5nZWQgdG86ICcgKyBwYy5pY2VDb25uZWN0aW9uU3RhdGUpO1xuXG4gICAgLy8gaWYgdGhlIHN0YXRlIGlzIGNoZWNraW5nLCB0aGVuIGRvIG5vdCByZXNldCB0aGUgZGlzY29ubmVjdCB0aW1lciBhc1xuICAgIC8vIHdlIGFyZSBkb2luZyBvdXIgb3duIGNoZWNraW5nXG4gICAgaWYgKENIRUNLSU5HX1NUQVRFUy5pbmRleE9mKHBjLmljZUNvbm5lY3Rpb25TdGF0ZSkgPj0gMCkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIHJlc2V0RGlzY29ubmVjdFRpbWVyKCk7XG5cbiAgICAvLyBpZiB3ZSBoYXZlIGEgY2xvc2VkIG9yIGZhaWxlZCBzdGF0dXMsIHRoZW4gY2xvc2UgdGhlIGNvbm5lY3Rpb25cbiAgICBpZiAoQ0xPU0VEX1NUQVRFUy5pbmRleE9mKHBjLmljZUNvbm5lY3Rpb25TdGF0ZSkgPj0gMCkge1xuICAgICAgcmV0dXJuIG1vbignY2xvc2VkJyk7XG4gICAgfVxuXG4gICAgbW9uLm9uY2UoJ2Rpc2Nvbm5lY3QnLCBoYW5kbGVEaXNjb25uZWN0KTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGhhbmRsZUxvY2FsQ2FuZGlkYXRlKGV2dCkge1xuICAgIHZhciBkYXRhID0gZXZ0LmNhbmRpZGF0ZSAmJiBwbHVja0NhbmRpZGF0ZShldnQuY2FuZGlkYXRlKTtcblxuICAgIGlmIChldnQuY2FuZGlkYXRlKSB7XG4gICAgICByZXNldERpc2Nvbm5lY3RUaW1lcigpO1xuICAgICAgZW1pdCgnaWNlLmxvY2FsJywgZGF0YSk7XG4gICAgICBzaWduYWxsZXIudG8odGFyZ2V0SWQpLnNlbmQoJy9jYW5kaWRhdGUnLCBkYXRhKTtcbiAgICAgIGVuZE9mQ2FuZGlkYXRlcyA9IGZhbHNlO1xuICAgIH1cbiAgICBlbHNlIGlmICghIGVuZE9mQ2FuZGlkYXRlcykge1xuICAgICAgZW5kT2ZDYW5kaWRhdGVzID0gdHJ1ZTtcbiAgICAgIGVtaXQoJ2ljZS5nYXRoZXJjb21wbGV0ZScpO1xuICAgICAgc2lnbmFsbGVyLnRvKHRhcmdldElkKS5zZW5kKCcvZW5kb2ZjYW5kaWRhdGVzJywge30pO1xuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIHJlcXVlc3ROZWdvdGlhdGlvbigpIHtcbiAgICAvLyBUaGlzIGlzIGEgcmVkdW5kYW50IHJlcXVlc3QgaWYgbm90IHJlYWN0aXZlXG4gICAgaWYgKGNvdXBsaW5nICYmICFyZWFjdGl2ZSkgcmV0dXJuO1xuXG4gICAgLy8gSWYgbm8gY291cGxpbmcgaXMgb2NjdXJyaW5nLCByZWdhcmRsZXNzIG9mIHJlYWN0aXZlLCBzdGFydCB0aGUgb2ZmZXIgcHJvY2Vzc1xuICAgIGlmICghY291cGxpbmcpIHJldHVybiBjcmVhdGVPclJlcXVlc3RPZmZlcigpO1xuXG4gICAgLy8gSWYgd2UgYXJlIGFscmVhZHkgY291cGxpbmcsIHdlIGFyZSByZWFjdGl2ZSBhbmQgcmVuZWdvdGlhdGlvbiBoYXMgbm90IGJlZW4gaW5kaWNhdGVkXG4gICAgLy8gZGVmZXIgYSBuZWdvdGlhdGlvbiByZXF1ZXN0XG4gICAgaWYgKGNvdXBsaW5nICYmIHJlYWN0aXZlICYmICFuZWdvdGlhdGlvblJlcXVpcmVkKSB7XG4gICAgICBkZWJ1ZygncmVuZWdvdGlhdGlvbiBpcyByZXF1aXJlZCwgYnV0IGRlZmVycmluZyB1bnRpbCBleGlzdGluZyBjb25uZWN0aW9uIGlzIGVzdGFibGlzaGVkJyk7XG4gICAgICBuZWdvdGlhdGlvblJlcXVpcmVkID0gdHJ1ZTtcblxuICAgICAgLy8gTk9URTogVGhpcyBpcyBjb21tZW50ZWQgb3V0LCBhcyB0aGUgZnVuY3Rpb25hbGl0eSBhZnRlciB0aGUgc2V0UmVtb3RlRGVzY3JpcHRpb25cbiAgICAgIC8vIHNob3VsZCBhZGVxdWF0ZWx5IHRha2UgY2FyZSBvZiB0aGlzLiBCdXQgc2hvdWxkIGl0IG5vdCwgcmUtZW5hYmxlIHRoaXNcbiAgICAgIC8vIG1vbi5vbmNlKCdjb25uZWN0aW9uc3RhdGU6Y29tcGxldGVkJywgZnVuY3Rpb24oKSB7XG4gICAgICAvLyAgIGNyZWF0ZU9yUmVxdWVzdE9mZmVyKCk7XG4gICAgICAvLyB9KTtcbiAgICB9XG4gIH1cblxuXG4gIC8qKlxuICAgIFRoaXMgYWxsb3dzIHRoZSBtYXN0ZXIgdG8gcmVxdWVzdCB0aGUgY2xpZW50IHRvIHNlbmQgYW4gb2ZmZXJcbiAgICoqL1xuICBmdW5jdGlvbiByZXF1ZXN0T2ZmZXJGcm9tQ2xpZW50KCkge1xuICAgIGlmIChyZXF1ZXN0T2ZmZXJUaW1lcikgY2xlYXJUaW1lb3V0KHJlcXVlc3RPZmZlclRpbWVyKTtcbiAgICBpZiAocGMuc2lnbmFsaW5nU3RhdGUgPT09ICdjbG9zZWQnKSByZXR1cm47XG5cbiAgICAvLyBDaGVjayBpZiB3ZSBhcmUgcmVhZHkgZm9yIGEgbmV3IG9mZmVyLCBvdGhlcndpc2UgZGVsYXlcbiAgICBpZiAoIWlzUmVhZHlGb3JPZmZlcigpKSB7XG4gICAgICBkZWJ1ZygnWycgKyBzaWduYWxsZXIuaWQgKyAnXSBuZWdvdGlhdGlvbiByZXF1ZXN0IGRlbmllZCwgbm90IGluIGEgc3RhdGUgdG8gYWNjZXB0IG5ldyBvZmZlcnMgW2NvdXBsaW5nID0gJyArIGNvdXBsaW5nICsgJywgJyArIHBjLnNpZ25hbGluZ1N0YXRlICsgJ10nKTtcbiAgICAgIHJlcXVlc3RPZmZlclRpbWVyID0gc2V0VGltZW91dChyZXF1ZXN0T2ZmZXJGcm9tQ2xpZW50LCA1MDApO1xuICAgIH0gZWxzZSB7XG4gICAgICAgLy8gRmxhZyBhcyBjb3VwbGluZyBhbmQgcmVxdWVzdCB0aGUgY2xpZW50IHNlbmQgdGhlIG9mZmVyXG4gICAgICBkZWJ1ZygnWycgKyBzaWduYWxsZXIuaWQgKyAnXSAnICsgdGFyZ2V0SWQgKyAnIGhhcyByZXF1ZXN0ZWQgdGhlIGFiaWxpdHkgdG8gY3JlYXRlIHRoZSBvZmZlcicpO1xuICAgICAgY291cGxpbmcgPSB0cnVlO1xuICAgICAgcmV0dXJuIHNpZ25hbGxlci50byh0YXJnZXRJZCkuc2VuZCgnL3JlcXVlc3RvZmZlcicpO1xuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIGhhbmRsZU5lZ290aWF0ZVJlcXVlc3QoZGF0YSwgc3JjKSB7XG4gICAgZGVidWcoJ1snICsgc2lnbmFsbGVyLmlkICsgJ10gJyArIHNyYy5pZCArICcgaGFzIHJlcXVlc3RlZCBhIG5lZ290aWF0aW9uJyk7XG5cbiAgICAvLyBTYW5pdHkgY2hlY2sgdGhhdCB0aGlzIGlzIGZvciB0aGUgdGFyZ2V0XG4gICAgaWYgKCFzcmMgfHwgc3JjLmlkICE9PSB0YXJnZXRJZCkgcmV0dXJuO1xuICAgIGVtaXQoJ25lZ290aWF0ZS5yZXF1ZXN0Jywgc3JjLmlkLCBkYXRhKTtcblxuICAgIC8vIENoZWNrIGlmIHRoZSBjbGllbnQgaXMgcmVxdWVzdGluZyB0aGUgYWJpbGl0eSB0byBjcmVhdGUgdGhlIG9mZmVyIHRoZW1zZWx2ZXNcbiAgICBpZiAoZGF0YSAmJiBkYXRhLnJlcXVlc3RPZmZlcmVyKSB7XG4gICAgICByZXR1cm4gcmVxdWVzdE9mZmVyRnJvbUNsaWVudCgpO1xuICAgIH1cblxuICAgIC8vIE90aGVyd2lzZSwgYmVnaW4gdGhlIHRyYWRpdGlvbmFsIG1hc3RlciBkcml2ZW4gbmVnb3RpYXRpb24gcHJvY2Vzc1xuICAgIHJlcXVlc3ROZWdvdGlhdGlvbigpO1xuICB9XG5cbiAgZnVuY3Rpb24gaGFuZGxlUmVuZWdvdGlhdGVSZXF1ZXN0KCkge1xuICAgIGlmICghcmVhY3RpdmUpIHJldHVybjtcbiAgICBlbWl0KCduZWdvdGlhdGUucmVuZWdvdGlhdGUnKTtcbiAgICByZW5lZ290aWF0ZVJlcXVpcmVkID0gdHJ1ZTtcbiAgICByZXF1ZXN0TmVnb3RpYXRpb24oKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIHJlc2V0RGlzY29ubmVjdFRpbWVyKCkge1xuICAgIHZhciByZWNvdmVyZWQgPSAhIWRpc2Nvbm5lY3RUaW1lciAmJiBDTE9TRURfU1RBVEVTLmluZGV4T2YocGMuaWNlQ29ubmVjdGlvblN0YXRlKSA9PT0gLTE7XG4gICAgbW9uLm9mZignc3RhdGVjaGFuZ2UnLCBoYW5kbGVEaXNjb25uZWN0QWJvcnQpO1xuXG4gICAgLy8gY2xlYXIgdGhlIGRpc2Nvbm5lY3QgdGltZXJcbiAgICBkZWJ1ZygncmVzZXQgZGlzY29ubmVjdCB0aW1lciwgc3RhdGU6ICcgKyBwYy5pY2VDb25uZWN0aW9uU3RhdGUpO1xuICAgIGNsZWFyVGltZW91dChkaXNjb25uZWN0VGltZXIpO1xuICAgIGRpc2Nvbm5lY3RUaW1lciA9IHVuZGVmaW5lZDtcblxuICAgIC8vIFRyaWdnZXIgdGhlIHJlY292ZXJlZCBldmVudCBpZiB0aGlzIGlzIGEgcmVjb3ZlcnlcbiAgICBpZiAocmVjb3ZlcmVkKSB7XG4gICAgICBtb24oJ3JlY292ZXJlZCcpO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgIEFsbG93IGNsaWVudHMgdG8gc2VuZCBvZmZlcnNcbiAgICoqL1xuICBmdW5jdGlvbiBoYW5kbGVSZXF1ZXN0T2ZmZXIoc3JjKSB7XG4gICAgaWYgKCFzcmMgfHwgc3JjLmlkICE9PSB0YXJnZXRJZCkgcmV0dXJuO1xuICAgIGRlYnVnKCdbJyArIHNpZ25hbGxlci5pZCArICddICcgKyB0YXJnZXRJZCArICcgaGFzIHJlcXVlc3RlZCB0aGF0IHRoZSBvZmZlciBiZSBzZW50IFsnICsgc3JjLmlkICsgJ10nKTtcbiAgICByZXR1cm4gY3JlYXRlT2ZmZXIoKTtcbiAgfVxuXG4gIC8vIHdoZW4gcmVnb3RpYXRpb24gaXMgbmVlZGVkIGxvb2sgZm9yIHRoZSBwZWVyXG4gIGlmIChyZWFjdGl2ZSkge1xuICAgIHBjLm9ubmVnb3RpYXRpb25uZWVkZWQgPSBoYW5kbGVSZW5lZ290aWF0ZVJlcXVlc3Q7XG4gIH1cblxuICBwYy5vbmljZWNhbmRpZGF0ZSA9IGhhbmRsZUxvY2FsQ2FuZGlkYXRlO1xuXG4gIC8vIHdoZW4gdGhlIHRhc2sgcXVldWUgdGVsbHMgdXMgd2UgaGF2ZSBzZHAgYXZhaWxhYmxlLCBzZW5kIHRoYXQgb3ZlciB0aGUgd2lyZVxuICBxLm9uKCdzZHAubG9jYWwnLCBmdW5jdGlvbihkZXNjKSB7XG4gICAgc2lnbmFsbGVyLnRvKHRhcmdldElkKS5zZW5kKCcvc2RwJywgZGVzYyk7XG4gIH0pO1xuXG4gIC8vIHdoZW4gd2UgcmVjZWl2ZSBzZHAsIHRoZW5cbiAgc2lnbmFsbGVyLm9uKCdzZHAnLCBoYW5kbGVTZHApO1xuICBzaWduYWxsZXIub24oJ2NhbmRpZGF0ZScsIGhhbmRsZUNhbmRpZGF0ZSk7XG4gIHNpZ25hbGxlci5vbignZW5kb2ZjYW5kaWRhdGVzJywgaGFuZGxlTGFzdENhbmRpZGF0ZSk7XG4gIHNpZ25hbGxlci5vbigncmVhZHknLCBoYW5kbGVSZWFkeSk7XG5cbiAgLy8gbGlzdGVuZXJzIChzaWduYWxsZXIgPj0gNSlcbiAgc2lnbmFsbGVyLm9uKCdtZXNzYWdlOnNkcCcsIGhhbmRsZVNkcCk7XG4gIHNpZ25hbGxlci5vbignbWVzc2FnZTpjYW5kaWRhdGUnLCBoYW5kbGVDYW5kaWRhdGUpO1xuICBzaWduYWxsZXIub24oJ21lc3NhZ2U6ZW5kb2ZjYW5kaWRhdGVzJywgaGFuZGxlTGFzdENhbmRpZGF0ZSk7XG4gIHNpZ25hbGxlci5vbignbWVzc2FnZTpyZWFkeScsIGhhbmRsZVJlYWR5KTtcblxuICAvLyBpZiB0aGlzIGlzIGEgbWFzdGVyIGNvbm5lY3Rpb24sIGxpc3RlbiBmb3IgbmVnb3RpYXRlIGV2ZW50c1xuICBpZiAoaXNNYXN0ZXIpIHtcbiAgICBzaWduYWxsZXIub24oJ25lZ290aWF0ZScsIGhhbmRsZU5lZ290aWF0ZVJlcXVlc3QpO1xuICAgIHNpZ25hbGxlci5vbignbWVzc2FnZTpuZWdvdGlhdGUnLCBoYW5kbGVOZWdvdGlhdGVSZXF1ZXN0KTsgLy8gc2lnbmFsbGVyID49IDVcbiAgfSBlbHNlIHtcbiAgICBzaWduYWxsZXIub24oJ3JlcXVlc3RvZmZlcicsIGhhbmRsZVJlcXVlc3RPZmZlcik7XG4gICAgc2lnbmFsbGVyLm9uKCdtZXNzYWdlOnJlcXVlc3RvZmZlcicsIGhhbmRsZVJlcXVlc3RPZmZlcik7XG4gIH1cblxuICAvLyB3aGVuIHRoZSBjb25uZWN0aW9uIGNsb3NlcywgcmVtb3ZlIGV2ZW50IGhhbmRsZXJzXG4gIG1vbi5vbmNlKCdjbG9zZWQnLCBoYW5kbGVDb25uZWN0aW9uQ2xvc2UpO1xuICBtb24ub25jZSgnZGlzY29ubmVjdGVkJywgaGFuZGxlRGlzY29ubmVjdCk7XG5cbiAgLy8gcGF0Y2ggaW4gdGhlIGNyZWF0ZSBvZmZlciBmdW5jdGlvbnNcbiAgbW9uLmNyZWF0ZU9mZmVyID0gY3JlYXRlT3JSZXF1ZXN0T2ZmZXI7XG5cbiAgLy8gQSBoZWF2eSBoYW5kZWQgYXBwcm9hY2ggdG8gZW5zdXJpbmcgcmVhZGluZXNzIGFjcm9zcyB0aGUgY291cGxpbmdcbiAgLy8gcGVlcnMuIFdpbGwgcGVyaW9kaWNhbGx5IHNlbmQgdGhlIGByZWFkeWAgbWVzc2FnZSB0byB0aGUgdGFyZ2V0IHBlZXJcbiAgLy8gdW50aWwgdGhlIHRhcmdldCBwZWVyIGhhcyBhY2tub3dsZWRnZWQgdGhhdCBpdCBhbHNvIGlzIHJlYWR5IC0gYXQgd2hpY2hcbiAgLy8gcG9pbnQgdGhlIG9mZmVyIGNhbiBiZSBzZW50XG4gIGZ1bmN0aW9uIGNoZWNrUmVhZHkoKSB7XG4gICAgY2xlYXJUaW1lb3V0KHJlYWR5VGltZXIpO1xuICAgIHNpZ25hbGxlci50byh0YXJnZXRJZCkuc2VuZCgnL3JlYWR5Jyk7XG5cbiAgICAvLyBJZiB3ZSBhcmUgcmVhZHksIHRoZXkndmUgdG9sZCB1cyB0aGV5IGFyZSByZWFkeSwgYW5kIHdlJ3ZlIHRvbGRcbiAgICAvLyB0aGVtIHdlJ3JlIHJlYWR5LCB0aGVuIGV4aXRcbiAgICBpZiAodGFyZ2V0UmVhZHkpIHJldHVybjtcblxuICAgIC8vIE90aGVyd2lzZSwga2VlcCB0ZWxsaW5nIHRoZW0gd2UncmUgcmVhZHlcbiAgICByZWFkeVRpbWVyID0gc2V0VGltZW91dChjaGVja1JlYWR5LCByZWFkeUludGVydmFsKTtcbiAgfVxuICBjaGVja1JlYWR5KCk7XG4gIGRlYnVnKCdbJyArIHNpZ25hbGxlci5pZCArICddIHJlYWR5IGZvciBjb3VwbGluZyB0byAnICsgdGFyZ2V0SWQpO1xuXG4gIC8vIElmIHdlIGZhaWwgdG8gY29ubmVjdCB3aXRoaW4gdGhlIGdpdmVuIHRpbWVmcmFtZSwgdHJpZ2dlciBhIGZhaWx1cmVcbiAgZmFpbFRpbWVyID0gc2V0VGltZW91dChmdW5jdGlvbigpIHtcbiAgICBtb24oJ2ZhaWxlZCcpO1xuICAgIGRlY291cGxlKCk7XG4gIH0sIGZhaWxUaW1lb3V0KTtcblxuICBtb24ub25jZSgnY29ubmVjdGVkJywgZnVuY3Rpb24oKSB7XG4gICAgY2xlYXJUaW1lb3V0KGZhaWxUaW1lcik7XG4gIH0pO1xuXG4gIG1vbi5vbignc2lnbmFsaW5nY2hhbmdlJywgZnVuY3Rpb24ocGMsIHN0YXRlKSB7XG4gICAgZGVidWcoJ1snICsgc2lnbmFsbGVyLmlkICsgJ10gc2lnbmFsaW5nIHN0YXRlICcgKyBzdGF0ZSArICcgdG8gJyArIHRhcmdldElkKTtcbiAgfSk7XG5cbiAgbW9uLm9uKCdzaWduYWxpbmc6c3RhYmxlJywgZnVuY3Rpb24oKSB7XG4gICAgLy8gQ2hlY2sgaWYgdGhlIGNvdXBsaW5nIHByb2Nlc3MgaXMgb3ZlclxuICAgIC8vIGNyZWF0aW5nT2ZmZXIgaXMgcmVxdWlyZWQgZHVlIHRvIHRoZSBkZWxheSBiZXR3ZWVuIHRoZSBjcmVhdGlvbiBvZiB0aGUgb2ZmZXIgYW5kIHRoZSBzaWduYWxpbmdcbiAgICAvLyBzdGF0ZSBjaGFuZ2luZyB0byBoYXZlLWxvY2FsLW9mZmVyXG4gICAgaWYgKCFjcmVhdGluZ09mZmVyICYmIGNvdXBsaW5nKSBjb3VwbGluZyA9IGZhbHNlO1xuXG4gICAgLy8gQ2hlY2sgaWYgd2UgaGF2ZSBhbnkgcGVuZGluZyBuZWdvdGlhdGlvbnNcbiAgICBpZiAobmVnb3RpYXRpb25SZXF1aXJlZCkge1xuICAgICAgY3JlYXRlT3JSZXF1ZXN0T2ZmZXIoKTtcbiAgICB9XG4gIH0pO1xuXG4gIG1vbi5zdG9wID0gZGVjb3VwbGU7XG5cbiAgLyoqXG4gICAgQWJvcnRzIHRoZSBjb3VwbGluZyBwcm9jZXNzXG4gICAqKi9cbiAgbW9uLmFib3J0ID0gZnVuY3Rpb24oKSB7XG4gICAgaWYgKGZhaWxUaW1lcikge1xuICAgICAgY2xlYXJUaW1lb3V0KGZhaWxUaW1lcik7XG4gICAgfVxuICAgIGRlY291cGxlKCk7XG4gICAgbW9uKCdhYm9ydGVkJyk7XG4gIH07XG5cbiAgLy8gT3ZlcnJpZGUgZGVzdHJveSB0byBjbGVhciB0aGUgdGFzayBxdWV1ZSBhcyB3ZWxsXG4gIG1vbi5kZXN0cm95ID0gZnVuY3Rpb24oKSB7XG4gICAgbW9uLmNsZWFyKCk7XG4gICAgcS5jbGVhcigpO1xuICB9O1xuXG4gIHJldHVybiBtb247XG59XG5cbm1vZHVsZS5leHBvcnRzID0gY291cGxlOyIsIi8qIGpzaGludCBub2RlOiB0cnVlICovXG4ndXNlIHN0cmljdCc7XG5cbi8qKlxuICAjIyMgcnRjLXRvb2xzL2RldGVjdFxuXG4gIFByb3ZpZGUgdGhlIFtydGMtY29yZS9kZXRlY3RdKGh0dHBzOi8vZ2l0aHViLmNvbS9ydGMtaW8vcnRjLWNvcmUjZGV0ZWN0KVxuICBmdW5jdGlvbmFsaXR5LlxuKiovXG5tb2R1bGUuZXhwb3J0cyA9IHJlcXVpcmUoJ3J0Yy1jb3JlL2RldGVjdCcpO1xuIiwiLyoganNoaW50IG5vZGU6IHRydWUgKi9cbid1c2Ugc3RyaWN0JztcblxudmFyIGRlYnVnID0gcmVxdWlyZSgnY29nL2xvZ2dlcicpKCdnZW5lcmF0b3JzJyk7XG52YXIgZGV0ZWN0ID0gcmVxdWlyZSgnLi9kZXRlY3QnKTtcbnZhciBkZWZhdWx0cyA9IHJlcXVpcmUoJ2NvZy9kZWZhdWx0cycpO1xuXG52YXIgbWFwcGluZ3MgPSB7XG4gIGNyZWF0ZToge1xuICAgIGR0bHM6IGZ1bmN0aW9uKGMpIHtcbiAgICAgIGlmICghIGRldGVjdC5tb3opIHtcbiAgICAgICAgYy5vcHRpb25hbCA9IChjLm9wdGlvbmFsIHx8IFtdKS5jb25jYXQoeyBEdGxzU3J0cEtleUFncmVlbWVudDogdHJ1ZSB9KTtcbiAgICAgIH1cbiAgICB9XG4gIH1cbn07XG5cbi8qKlxuICAjIyMgcnRjLXRvb2xzL2dlbmVyYXRvcnNcblxuICBUaGUgZ2VuZXJhdG9ycyBwYWNrYWdlIHByb3ZpZGVzIHNvbWUgdXRpbGl0eSBtZXRob2RzIGZvciBnZW5lcmF0aW5nXG4gIGNvbnN0cmFpbnQgb2JqZWN0cyBhbmQgc2ltaWxhciBjb25zdHJ1Y3RzLlxuXG4gIGBgYGpzXG4gIHZhciBnZW5lcmF0b3JzID0gcmVxdWlyZSgncnRjL2dlbmVyYXRvcnMnKTtcbiAgYGBgXG5cbioqL1xuXG4vKipcbiAgIyMjIyBnZW5lcmF0b3JzLmNvbmZpZyhjb25maWcpXG5cbiAgR2VuZXJhdGUgYSBjb25maWd1cmF0aW9uIG9iamVjdCBzdWl0YWJsZSBmb3IgcGFzc2luZyBpbnRvIGFuIFczQ1xuICBSVENQZWVyQ29ubmVjdGlvbiBjb25zdHJ1Y3RvciBmaXJzdCBhcmd1bWVudCwgYmFzZWQgb24gb3VyIGN1c3RvbSBjb25maWcuXG5cbiAgSW4gdGhlIGV2ZW50IHRoYXQgeW91IHVzZSBzaG9ydCB0ZXJtIGF1dGhlbnRpY2F0aW9uIGZvciBUVVJOLCBhbmQgeW91IHdhbnRcbiAgdG8gZ2VuZXJhdGUgbmV3IGBpY2VTZXJ2ZXJzYCByZWd1bGFybHksIHlvdSBjYW4gc3BlY2lmeSBhbiBpY2VTZXJ2ZXJHZW5lcmF0b3JcbiAgdGhhdCB3aWxsIGJlIHVzZWQgcHJpb3IgdG8gY291cGxpbmcuIFRoaXMgZ2VuZXJhdG9yIHNob3VsZCByZXR1cm4gYSBmdWxseVxuICBjb21wbGlhbnQgVzNDIChSVENJY2VTZXJ2ZXIgZGljdGlvbmFyeSlbaHR0cDovL3d3dy53My5vcmcvVFIvd2VicnRjLyNpZGwtZGVmLVJUQ0ljZVNlcnZlcl0uXG5cbiAgSWYgeW91IHBhc3MgaW4gYm90aCBhIGdlbmVyYXRvciBhbmQgaWNlU2VydmVycywgdGhlIGljZVNlcnZlcnMgX3dpbGwgYmVcbiAgaWdub3JlZCBhbmQgdGhlIGdlbmVyYXRvciB1c2VkIGluc3RlYWQuXG4qKi9cblxuZXhwb3J0cy5jb25maWcgPSBmdW5jdGlvbihjb25maWcpIHtcbiAgdmFyIGljZVNlcnZlckdlbmVyYXRvciA9IChjb25maWcgfHwge30pLmljZVNlcnZlckdlbmVyYXRvcjtcblxuICByZXR1cm4gZGVmYXVsdHMoe30sIGNvbmZpZywge1xuICAgIGljZVNlcnZlcnM6IHR5cGVvZiBpY2VTZXJ2ZXJHZW5lcmF0b3IgPT0gJ2Z1bmN0aW9uJyA/IGljZVNlcnZlckdlbmVyYXRvcigpIDogW11cbiAgfSk7XG59O1xuXG4vKipcbiAgIyMjIyBnZW5lcmF0b3JzLmNvbm5lY3Rpb25Db25zdHJhaW50cyhmbGFncywgY29uc3RyYWludHMpXG5cbiAgVGhpcyBpcyBhIGhlbHBlciBmdW5jdGlvbiB0aGF0IHdpbGwgZ2VuZXJhdGUgYXBwcm9wcmlhdGUgY29ubmVjdGlvblxuICBjb25zdHJhaW50cyBmb3IgYSBuZXcgYFJUQ1BlZXJDb25uZWN0aW9uYCBvYmplY3Qgd2hpY2ggaXMgY29uc3RydWN0ZWRcbiAgaW4gdGhlIGZvbGxvd2luZyB3YXk6XG5cbiAgYGBganNcbiAgdmFyIGNvbm4gPSBuZXcgUlRDUGVlckNvbm5lY3Rpb24oZmxhZ3MsIGNvbnN0cmFpbnRzKTtcbiAgYGBgXG5cbiAgSW4gbW9zdCBjYXNlcyB0aGUgY29uc3RyYWludHMgb2JqZWN0IGNhbiBiZSBsZWZ0IGVtcHR5LCBidXQgd2hlbiBjcmVhdGluZ1xuICBkYXRhIGNoYW5uZWxzIHNvbWUgYWRkaXRpb25hbCBvcHRpb25zIGFyZSByZXF1aXJlZC4gIFRoaXMgZnVuY3Rpb25cbiAgY2FuIGdlbmVyYXRlIHRob3NlIGFkZGl0aW9uYWwgb3B0aW9ucyBhbmQgaW50ZWxsaWdlbnRseSBjb21iaW5lIGFueVxuICB1c2VyIGRlZmluZWQgY29uc3RyYWludHMgKGluIGBjb25zdHJhaW50c2ApIHdpdGggc2hvcnRoYW5kIGZsYWdzIHRoYXRcbiAgbWlnaHQgYmUgcGFzc2VkIHdoaWxlIHVzaW5nIHRoZSBgcnRjLmNyZWF0ZUNvbm5lY3Rpb25gIGhlbHBlci5cbioqL1xuZXhwb3J0cy5jb25uZWN0aW9uQ29uc3RyYWludHMgPSBmdW5jdGlvbihmbGFncywgY29uc3RyYWludHMpIHtcbiAgdmFyIGdlbmVyYXRlZCA9IHt9O1xuICB2YXIgbSA9IG1hcHBpbmdzLmNyZWF0ZTtcbiAgdmFyIG91dDtcblxuICAvLyBpdGVyYXRlIHRocm91Z2ggdGhlIGZsYWdzIGFuZCBhcHBseSB0aGUgY3JlYXRlIG1hcHBpbmdzXG4gIE9iamVjdC5rZXlzKGZsYWdzIHx8IHt9KS5mb3JFYWNoKGZ1bmN0aW9uKGtleSkge1xuICAgIGlmIChtW2tleV0pIHtcbiAgICAgIG1ba2V5XShnZW5lcmF0ZWQpO1xuICAgIH1cbiAgfSk7XG5cbiAgLy8gZ2VuZXJhdGUgdGhlIGNvbm5lY3Rpb24gY29uc3RyYWludHNcbiAgb3V0ID0gZGVmYXVsdHMoe30sIGNvbnN0cmFpbnRzLCBnZW5lcmF0ZWQpO1xuICBkZWJ1ZygnZ2VuZXJhdGVkIGNvbm5lY3Rpb24gY29uc3RyYWludHM6ICcsIG91dCk7XG5cbiAgcmV0dXJuIG91dDtcbn07XG4iLCIvKiBqc2hpbnQgbm9kZTogdHJ1ZSAqL1xuXG4ndXNlIHN0cmljdCc7XG5cbi8qKlxuICAjIHJ0Yy10b29sc1xuXG4gIFRoZSBgcnRjLXRvb2xzYCBtb2R1bGUgZG9lcyBtb3N0IG9mIHRoZSBoZWF2eSBsaWZ0aW5nIHdpdGhpbiB0aGVcbiAgW3J0Yy5pb10oaHR0cDovL3J0Yy5pbykgc3VpdGUuICBQcmltYXJpbHkgaXQgaGFuZGxlcyB0aGUgbG9naWMgb2YgY291cGxpbmdcbiAgYSBsb2NhbCBgUlRDUGVlckNvbm5lY3Rpb25gIHdpdGggaXQncyByZW1vdGUgY291bnRlcnBhcnQgdmlhIGFuXG4gIFtydGMtc2lnbmFsbGVyXShodHRwczovL2dpdGh1Yi5jb20vcnRjLWlvL3J0Yy1zaWduYWxsZXIpIHNpZ25hbGxpbmdcbiAgY2hhbm5lbC5cblxuICAjIyBHZXR0aW5nIFN0YXJ0ZWRcblxuICBJZiB5b3UgZGVjaWRlIHRoYXQgdGhlIGBydGMtdG9vbHNgIG1vZHVsZSBpcyBhIGJldHRlciBmaXQgZm9yIHlvdSB0aGFuIGVpdGhlclxuICBbcnRjLXF1aWNrY29ubmVjdF0oaHR0cHM6Ly9naXRodWIuY29tL3J0Yy1pby9ydGMtcXVpY2tjb25uZWN0KSBvclxuICBbcnRjXShodHRwczovL2dpdGh1Yi5jb20vcnRjLWlvL3J0YykgdGhlbiB0aGUgY29kZSBzbmlwcGV0IGJlbG93XG4gIHdpbGwgcHJvdmlkZSB5b3UgYSBndWlkZSBvbiBob3cgdG8gZ2V0IHN0YXJ0ZWQgdXNpbmcgaXQgaW4gY29uanVuY3Rpb24gd2l0aFxuICB0aGUgW3J0Yy1zaWduYWxsZXJdKGh0dHBzOi8vZ2l0aHViLmNvbS9ydGMtaW8vcnRjLXNpZ25hbGxlcikgKHZlcnNpb24gNS4wIGFuZCBhYm92ZSlcbiAgYW5kIFtydGMtbWVkaWFdKGh0dHBzOi8vZ2l0aHViLmNvbS9ydGMtaW8vcnRjLW1lZGlhKSBtb2R1bGVzOlxuXG4gIDw8PCBleGFtcGxlcy9nZXR0aW5nLXN0YXJ0ZWQuanNcblxuICBUaGlzIGNvZGUgZGVmaW5pdGVseSBkb2Vzbid0IGNvdmVyIGFsbCB0aGUgY2FzZXMgdGhhdCB5b3UgbmVlZCB0byBjb25zaWRlclxuICAoaS5lLiBwZWVycyBsZWF2aW5nLCBldGMpIGJ1dCBpdCBzaG91bGQgZGVtb25zdHJhdGUgaG93IHRvOlxuXG4gIDEuIENhcHR1cmUgdmlkZW8gYW5kIGFkZCBpdCB0byBhIHBlZXIgY29ubmVjdGlvblxuICAyLiBDb3VwbGUgYSBsb2NhbCBwZWVyIGNvbm5lY3Rpb24gd2l0aCBhIHJlbW90ZSBwZWVyIGNvbm5lY3Rpb25cbiAgMy4gRGVhbCB3aXRoIHRoZSByZW1vdGUgc3RlYW0gYmVpbmcgZGlzY292ZXJlZCBhbmQgaG93IHRvIHJlbmRlclxuICAgICB0aGF0IHRvIHRoZSBsb2NhbCBpbnRlcmZhY2UuXG5cbiAgIyMgUmVmZXJlbmNlXG5cbioqL1xuXG52YXIgZ2VuID0gcmVxdWlyZSgnLi9nZW5lcmF0b3JzJyk7XG5cbi8vIGV4cG9ydCBkZXRlY3RcbnZhciBkZXRlY3QgPSBleHBvcnRzLmRldGVjdCA9IHJlcXVpcmUoJy4vZGV0ZWN0Jyk7XG52YXIgZmluZFBsdWdpbiA9IHJlcXVpcmUoJ3J0Yy1jb3JlL3BsdWdpbicpO1xuXG4vLyBleHBvcnQgY29nIGxvZ2dlciBmb3IgY29udmVuaWVuY2VcbmV4cG9ydHMubG9nZ2VyID0gcmVxdWlyZSgnY29nL2xvZ2dlcicpO1xuXG4vLyBleHBvcnQgcGVlciBjb25uZWN0aW9uXG52YXIgUlRDUGVlckNvbm5lY3Rpb24gPVxuZXhwb3J0cy5SVENQZWVyQ29ubmVjdGlvbiA9IGRldGVjdCgnUlRDUGVlckNvbm5lY3Rpb24nKTtcblxuLy8gYWRkIHRoZSBjb3VwbGUgdXRpbGl0eVxuZXhwb3J0cy5jb3VwbGUgPSByZXF1aXJlKCcuL2NvdXBsZScpO1xuXG4vKipcbiAgIyMjIGNyZWF0ZUNvbm5lY3Rpb25cblxuICBgYGBcbiAgY3JlYXRlQ29ubmVjdGlvbihvcHRzPywgY29uc3RyYWludHM/KSA9PiBSVENQZWVyQ29ubmVjdGlvblxuICBgYGBcblxuICBDcmVhdGUgYSBuZXcgYFJUQ1BlZXJDb25uZWN0aW9uYCBhdXRvIGdlbmVyYXRpbmcgZGVmYXVsdCBvcHRzIGFzIHJlcXVpcmVkLlxuXG4gIGBgYGpzXG4gIHZhciBjb25uO1xuXG4gIC8vIHRoaXMgaXMgb2tcbiAgY29ubiA9IHJ0Yy5jcmVhdGVDb25uZWN0aW9uKCk7XG5cbiAgLy8gYW5kIHNvIGlzIHRoaXNcbiAgY29ubiA9IHJ0Yy5jcmVhdGVDb25uZWN0aW9uKHtcbiAgICBpY2VTZXJ2ZXJzOiBbXVxuICB9KTtcbiAgYGBgXG4qKi9cbmV4cG9ydHMuY3JlYXRlQ29ubmVjdGlvbiA9IGZ1bmN0aW9uKG9wdHMsIGNvbnN0cmFpbnRzKSB7XG4gIHZhciBwbHVnaW4gPSBmaW5kUGx1Z2luKChvcHRzIHx8IHt9KS5wbHVnaW5zKTtcbiAgdmFyIFBlZXJDb25uZWN0aW9uID0gKG9wdHMgfHwge30pLlJUQ1BlZXJDb25uZWN0aW9uIHx8IFJUQ1BlZXJDb25uZWN0aW9uO1xuXG4gIC8vIGdlbmVyYXRlIHRoZSBjb25maWcgYmFzZWQgb24gb3B0aW9ucyBwcm92aWRlZFxuICB2YXIgY29uZmlnID0gZ2VuLmNvbmZpZyhvcHRzKTtcblxuICAvLyBnZW5lcmF0ZSBhcHByb3ByaWF0ZSBjb25uZWN0aW9uIGNvbnN0cmFpbnRzXG4gIGNvbnN0cmFpbnRzID0gZ2VuLmNvbm5lY3Rpb25Db25zdHJhaW50cyhvcHRzLCBjb25zdHJhaW50cyk7XG5cbiAgaWYgKHBsdWdpbiAmJiB0eXBlb2YgcGx1Z2luLmNyZWF0ZUNvbm5lY3Rpb24gPT0gJ2Z1bmN0aW9uJykge1xuICAgIHJldHVybiBwbHVnaW4uY3JlYXRlQ29ubmVjdGlvbihjb25maWcsIGNvbnN0cmFpbnRzKTtcbiAgfVxuXG4gIHJldHVybiBuZXcgUGVlckNvbm5lY3Rpb24oY29uZmlnLCBjb25zdHJhaW50cyk7XG59O1xuIiwiLyoganNoaW50IG5vZGU6IHRydWUgKi9cbid1c2Ugc3RyaWN0JztcblxudmFyIG1idXMgPSByZXF1aXJlKCdtYnVzJyk7XG5cbi8vIGRlZmluZSBzb21lIHN0YXRlIG1hcHBpbmdzIHRvIHNpbXBsaWZ5IHRoZSBldmVudHMgd2UgZ2VuZXJhdGVcbnZhciBzdGF0ZU1hcHBpbmdzID0ge1xuICBjb21wbGV0ZWQ6ICdjb25uZWN0ZWQnXG59O1xuXG4vLyBkZWZpbmUgdGhlIGV2ZW50cyB0aGF0IHdlIG5lZWQgdG8gd2F0Y2ggZm9yIHBlZXIgY29ubmVjdGlvblxuLy8gc3RhdGUgY2hhbmdlc1xudmFyIHBlZXJTdGF0ZUV2ZW50cyA9IFtcbiAgJ3NpZ25hbGluZ3N0YXRlY2hhbmdlJyxcbiAgJ2ljZWNvbm5lY3Rpb25zdGF0ZWNoYW5nZScsXG5dO1xuXG4vKipcbiAgIyMjIHJ0Yy10b29scy9tb25pdG9yXG5cbiAgYGBgXG4gIG1vbml0b3IocGMsIHRhcmdldElkLCBzaWduYWxsZXIsIHBhcmVudEJ1cykgPT4gbWJ1c1xuICBgYGBcblxuICBUaGUgbW9uaXRvciBpcyBhIHVzZWZ1bCB0b29sIGZvciBkZXRlcm1pbmluZyB0aGUgc3RhdGUgb2YgYHBjYCAoYW5cbiAgYFJUQ1BlZXJDb25uZWN0aW9uYCkgaW5zdGFuY2UgaW4gdGhlIGNvbnRleHQgb2YgeW91ciBhcHBsaWNhdGlvbi4gVGhlXG4gIG1vbml0b3IgdXNlcyBib3RoIHRoZSBgaWNlQ29ubmVjdGlvblN0YXRlYCBpbmZvcm1hdGlvbiBvZiB0aGUgcGVlclxuICBjb25uZWN0aW9uIGFuZCBhbHNvIHRoZSB2YXJpb3VzXG4gIFtzaWduYWxsZXIgZXZlbnRzXShodHRwczovL2dpdGh1Yi5jb20vcnRjLWlvL3J0Yy1zaWduYWxsZXIjc2lnbmFsbGVyLWV2ZW50cylcbiAgdG8gZGV0ZXJtaW5lIHdoZW4gdGhlIGNvbm5lY3Rpb24gaGFzIGJlZW4gYGNvbm5lY3RlZGAgYW5kIHdoZW4gaXQgaGFzXG4gIGJlZW4gYGRpc2Nvbm5lY3RlZGAuXG5cbiAgQSBtb25pdG9yIGNyZWF0ZWQgYG1idXNgIGlzIHJldHVybmVkIGFzIHRoZSByZXN1bHQgb2YgYVxuICBbY291cGxlXShodHRwczovL2dpdGh1Yi5jb20vcnRjLWlvL3J0YyNydGNjb3VwbGUpIGJldHdlZW4gYSBsb2NhbCBwZWVyXG4gIGNvbm5lY3Rpb24gYW5kIGl0J3MgcmVtb3RlIGNvdW50ZXJwYXJ0LlxuXG4qKi9cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24ocGMsIHRhcmdldElkLCBzaWduYWxsZXIsIHBhcmVudEJ1cykge1xuICB2YXIgbW9uaXRvciA9IG1idXMoJycsIHBhcmVudEJ1cyk7XG4gIHZhciBzdGF0ZTtcbiAgdmFyIGNvbm5lY3Rpb25TdGF0ZTtcbiAgdmFyIHNpZ25hbGluZ1N0YXRlO1xuICB2YXIgaXNDbG9zZWQgPSBmYWxzZTtcblxuICBmdW5jdGlvbiBjaGVja1N0YXRlKCkge1xuICAgIHZhciBuZXdDb25uZWN0aW9uU3RhdGUgPSBwYy5pY2VDb25uZWN0aW9uU3RhdGU7XG4gICAgdmFyIG5ld1N0YXRlID0gZ2V0TWFwcGVkU3RhdGUobmV3Q29ubmVjdGlvblN0YXRlKTtcbiAgICB2YXIgbmV3U2lnbmFsaW5nU3RhdGUgPSBwYy5zaWduYWxpbmdTdGF0ZTtcblxuICAgIC8vIGZsYWcgdGhlIHdlIGhhZCBhIHN0YXRlIGNoYW5nZVxuICAgIG1vbml0b3IoJ3N0YXRlY2hhbmdlJywgcGMsIG5ld1N0YXRlKTtcbiAgICBtb25pdG9yKCdjb25uZWN0aW9uc3RhdGVjaGFuZ2UnLCBwYywgbmV3Q29ubmVjdGlvblN0YXRlKTtcblxuICAgIC8vIGlmIHRoZSBhY3RpdmUgc3RhdGUgaGFzIGNoYW5nZWQsIHRoZW4gc2VuZCB0aGUgYXBwb3ByaWF0ZSBtZXNzYWdlXG4gICAgaWYgKHN0YXRlICE9PSBuZXdTdGF0ZSkge1xuICAgICAgbW9uaXRvcihuZXdTdGF0ZSk7XG4gICAgICBzdGF0ZSA9IG5ld1N0YXRlO1xuICAgIH1cblxuICAgIGlmIChjb25uZWN0aW9uU3RhdGUgIT09IG5ld0Nvbm5lY3Rpb25TdGF0ZSkge1xuICAgICAgbW9uaXRvcignY29ubmVjdGlvbnN0YXRlOicgKyBuZXdDb25uZWN0aW9uU3RhdGUpO1xuICAgICAgY29ubmVjdGlvblN0YXRlID0gbmV3Q29ubmVjdGlvblN0YXRlO1xuICAgIH1cblxuICAgIC8vIEFzIEZpcmVmb3ggZG9lcyBub3QgYWx3YXlzIHN1cHBvcnQgYG9uY2xvc2VgLCBpZiB0aGUgc3RhdGUgaXMgY2xvc2VkXG4gICAgLy8gYW5kIHdlIGhhdmVuJ3QgYWxyZWFkeSBoYW5kbGVkIHRoZSBjbG9zZSwgZG8gc28gbm93XG4gICAgaWYgKG5ld1N0YXRlID09PSAnY2xvc2VkJyAmJiAhaXNDbG9zZWQpIHtcbiAgICAgIGhhbmRsZUNsb3NlKCk7XG4gICAgfVxuXG4gICAgLy8gQ2hlY2sgdGhlIHNpZ25hbGxpbmcgc3RhdGUgdG8gc2VlIGlmIGl0IGhhcyBhbHNvIGNoYW5nZWRcbiAgICBpZiAoc2lnbmFsaW5nU3RhdGUgIT09IG5ld1NpZ25hbGluZ1N0YXRlKSB7XG4gICAgICBtb25pdG9yKCdzaWduYWxpbmdjaGFuZ2UnLCBwYywgbmV3U2lnbmFsaW5nU3RhdGUsIHNpZ25hbGluZ1N0YXRlKTtcbiAgICAgIG1vbml0b3IoJ3NpZ25hbGluZzonICsgbmV3U2lnbmFsaW5nU3RhdGUsIHBjLCBuZXdTaWduYWxpbmdTdGF0ZSwgc2lnbmFsaW5nU3RhdGUpO1xuICAgICAgc2lnbmFsaW5nU3RhdGUgPSBuZXdTaWduYWxpbmdTdGF0ZTtcbiAgICB9XG4gIH1cblxuICBmdW5jdGlvbiBoYW5kbGVDbG9zZSgpIHtcbiAgICBpc0Nsb3NlZCA9IHRydWU7XG4gICAgbW9uaXRvcignY2xvc2VkJyk7XG4gIH1cblxuICBwYy5vbmNsb3NlID0gaGFuZGxlQ2xvc2U7XG4gIHBlZXJTdGF0ZUV2ZW50cy5mb3JFYWNoKGZ1bmN0aW9uKGV2dE5hbWUpIHtcbiAgICBwY1snb24nICsgZXZ0TmFtZV0gPSBjaGVja1N0YXRlO1xuICB9KTtcblxuICBtb25pdG9yLmNsb3NlID0gZnVuY3Rpb24oKSB7XG4gICAgcGMub25jbG9zZSA9IG51bGw7XG4gICAgcGVlclN0YXRlRXZlbnRzLmZvckVhY2goZnVuY3Rpb24oZXZ0TmFtZSkge1xuICAgICAgcGNbJ29uJyArIGV2dE5hbWVdID0gbnVsbDtcbiAgICB9KTtcbiAgfTtcblxuICBtb25pdG9yLmNoZWNrU3RhdGUgPSBjaGVja1N0YXRlO1xuXG4gIG1vbml0b3IuZGVzdHJveSA9IGZ1bmN0aW9uKCkge1xuICAgIG1vbml0b3IuY2xlYXIoKTtcbiAgfTtcblxuICAvLyBpZiB3ZSBoYXZlbid0IGJlZW4gcHJvdmlkZWQgYSB2YWxpZCBwZWVyIGNvbm5lY3Rpb24sIGFib3J0XG4gIGlmICghIHBjKSB7XG4gICAgcmV0dXJuIG1vbml0b3I7XG4gIH1cblxuICAvLyBkZXRlcm1pbmUgdGhlIGluaXRpYWwgaXMgYWN0aXZlIHN0YXRlXG4gIHN0YXRlID0gZ2V0TWFwcGVkU3RhdGUocGMuaWNlQ29ubmVjdGlvblN0YXRlKTtcblxuICByZXR1cm4gbW9uaXRvcjtcbn07XG5cbi8qIGludGVybmFsIGhlbHBlcnMgKi9cblxuZnVuY3Rpb24gZ2V0TWFwcGVkU3RhdGUoc3RhdGUpIHtcbiAgcmV0dXJuIHN0YXRlTWFwcGluZ3Nbc3RhdGVdIHx8IHN0YXRlO1xufVxuIiwidmFyIGRlYnVnID0gcmVxdWlyZSgnY29nL2xvZ2dlcicpKCdydGMtdmFsaWRhdG9yJyk7XG52YXIgcmVQcmVmaXggPSAvXig/OmE9KT9jYW5kaWRhdGU6LztcblxuLypcblxudmFsaWRhdGlvbiBydWxlcyBhcyBwZXI6XG5odHRwOi8vdG9vbHMuaWV0Zi5vcmcvaHRtbC9kcmFmdC1pZXRmLW1tdXNpYy1pY2Utc2lwLXNkcC0wMyNzZWN0aW9uLTguMVxuXG4gICBjYW5kaWRhdGUtYXR0cmlidXRlICAgPSBcImNhbmRpZGF0ZVwiIFwiOlwiIGZvdW5kYXRpb24gU1AgY29tcG9uZW50LWlkIFNQXG4gICAgICAgICAgICAgICAgICAgICAgICAgICB0cmFuc3BvcnQgU1BcbiAgICAgICAgICAgICAgICAgICAgICAgICAgIHByaW9yaXR5IFNQXG4gICAgICAgICAgICAgICAgICAgICAgICAgICBjb25uZWN0aW9uLWFkZHJlc3MgU1AgICAgIDtmcm9tIFJGQyA0NTY2XG4gICAgICAgICAgICAgICAgICAgICAgICAgICBwb3J0ICAgICAgICAgO3BvcnQgZnJvbSBSRkMgNDU2NlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgU1AgY2FuZC10eXBlXG4gICAgICAgICAgICAgICAgICAgICAgICAgICBbU1AgcmVsLWFkZHJdXG4gICAgICAgICAgICAgICAgICAgICAgICAgICBbU1AgcmVsLXBvcnRdXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAqKFNQIGV4dGVuc2lvbi1hdHQtbmFtZSBTUFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBleHRlbnNpb24tYXR0LXZhbHVlKVxuXG4gICBmb3VuZGF0aW9uICAgICAgICAgICAgPSAxKjMyaWNlLWNoYXJcbiAgIGNvbXBvbmVudC1pZCAgICAgICAgICA9IDEqNURJR0lUXG4gICB0cmFuc3BvcnQgICAgICAgICAgICAgPSBcIlVEUFwiIC8gdHJhbnNwb3J0LWV4dGVuc2lvblxuICAgdHJhbnNwb3J0LWV4dGVuc2lvbiAgID0gdG9rZW4gICAgICAgICAgICAgIDsgZnJvbSBSRkMgMzI2MVxuICAgcHJpb3JpdHkgICAgICAgICAgICAgID0gMSoxMERJR0lUXG4gICBjYW5kLXR5cGUgICAgICAgICAgICAgPSBcInR5cFwiIFNQIGNhbmRpZGF0ZS10eXBlc1xuICAgY2FuZGlkYXRlLXR5cGVzICAgICAgID0gXCJob3N0XCIgLyBcInNyZmx4XCIgLyBcInByZmx4XCIgLyBcInJlbGF5XCIgLyB0b2tlblxuICAgcmVsLWFkZHIgICAgICAgICAgICAgID0gXCJyYWRkclwiIFNQIGNvbm5lY3Rpb24tYWRkcmVzc1xuICAgcmVsLXBvcnQgICAgICAgICAgICAgID0gXCJycG9ydFwiIFNQIHBvcnRcbiAgIGV4dGVuc2lvbi1hdHQtbmFtZSAgICA9IHRva2VuXG4gICBleHRlbnNpb24tYXR0LXZhbHVlICAgPSAqVkNIQVJcbiAgIGljZS1jaGFyICAgICAgICAgICAgICA9IEFMUEhBIC8gRElHSVQgLyBcIitcIiAvIFwiL1wiXG4qL1xudmFyIHBhcnRWYWxpZGF0aW9uID0gW1xuICBbIC8uKy8sICdpbnZhbGlkIGZvdW5kYXRpb24gY29tcG9uZW50JywgJ2ZvdW5kYXRpb24nIF0sXG4gIFsgL1xcZCsvLCAnaW52YWxpZCBjb21wb25lbnQgaWQnLCAnY29tcG9uZW50LWlkJyBdLFxuICBbIC8oVURQfFRDUCkvaSwgJ3RyYW5zcG9ydCBtdXN0IGJlIFRDUCBvciBVRFAnLCAndHJhbnNwb3J0JyBdLFxuICBbIC9cXGQrLywgJ251bWVyaWMgcHJpb3JpdHkgZXhwZWN0ZWQnLCAncHJpb3JpdHknIF0sXG4gIFsgcmVxdWlyZSgncmV1L2lwJyksICdpbnZhbGlkIGNvbm5lY3Rpb24gYWRkcmVzcycsICdjb25uZWN0aW9uLWFkZHJlc3MnIF0sXG4gIFsgL1xcZCsvLCAnaW52YWxpZCBjb25uZWN0aW9uIHBvcnQnLCAnY29ubmVjdGlvbi1wb3J0JyBdLFxuICBbIC90eXAvLCAnRXhwZWN0ZWQgXCJ0eXBcIiBpZGVudGlmaWVyJywgJ3R5cGUgY2xhc3NpZmllcicgXSxcbiAgWyAvLisvLCAnSW52YWxpZCBjYW5kaWRhdGUgdHlwZSBzcGVjaWZpZWQnLCAnY2FuZGlkYXRlLXR5cGUnIF1cbl07XG5cbi8qKlxuICAjIyMgYHJ0Yy12YWxpZGF0b3IvY2FuZGlkYXRlYFxuXG4gIFZhbGlkYXRlIHRoYXQgYW4gYFJUQ0ljZUNhbmRpZGF0ZWAgKG9yIHBsYWluIG9sZCBvYmplY3Qgd2l0aCBkYXRhLCBzZHBNaWQsXG4gIGV0YyBhdHRyaWJ1dGVzKSBpcyBhIHZhbGlkIGljZSBjYW5kaWRhdGUuXG5cbiAgU3BlY3MgcmV2aWV3ZWQgYXMgcGFydCBvZiB0aGUgdmFsaWRhdGlvbiBpbXBsZW1lbnRhdGlvbjpcblxuICAtIDxodHRwOi8vdG9vbHMuaWV0Zi5vcmcvaHRtbC9kcmFmdC1pZXRmLW1tdXNpYy1pY2Utc2lwLXNkcC0wMyNzZWN0aW9uLTguMT5cbiAgLSA8aHR0cDovL3Rvb2xzLmlldGYub3JnL2h0bWwvcmZjNTI0NT5cblxuKiovXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKGRhdGEpIHtcbiAgdmFyIGVycm9ycyA9IFtdO1xuICB2YXIgY2FuZGlkYXRlID0gZGF0YSAmJiAoZGF0YS5jYW5kaWRhdGUgfHwgZGF0YSk7XG4gIHZhciBwcmVmaXhNYXRjaCA9IGNhbmRpZGF0ZSAmJiByZVByZWZpeC5leGVjKGNhbmRpZGF0ZSk7XG4gIHZhciBwYXJ0cyA9IHByZWZpeE1hdGNoICYmIGNhbmRpZGF0ZS5zbGljZShwcmVmaXhNYXRjaFswXS5sZW5ndGgpLnNwbGl0KC9cXHMvKTtcblxuICBpZiAoISBjYW5kaWRhdGUpIHtcbiAgICByZXR1cm4gWyBuZXcgRXJyb3IoJ2VtcHR5IGNhbmRpZGF0ZScpIF07XG4gIH1cblxuICAvLyBjaGVjayB0aGF0IHRoZSBwcmVmaXggbWF0Y2hlcyBleHBlY3RlZFxuICBpZiAoISBwcmVmaXhNYXRjaCkge1xuICAgIHJldHVybiBbIG5ldyBFcnJvcignY2FuZGlkYXRlIGRpZCBub3QgbWF0Y2ggZXhwZWN0ZWQgc2RwIGxpbmUgZm9ybWF0JykgXTtcbiAgfVxuXG4gIC8vIHBlcmZvcm0gdGhlIHBhcnQgdmFsaWRhdGlvblxuICBlcnJvcnMgPSBlcnJvcnMuY29uY2F0KHBhcnRzLm1hcCh2YWxpZGF0ZVBhcnRzKSkuZmlsdGVyKEJvb2xlYW4pO1xuXG4gIHJldHVybiBlcnJvcnM7XG59O1xuXG5mdW5jdGlvbiB2YWxpZGF0ZVBhcnRzKHBhcnQsIGlkeCkge1xuICB2YXIgdmFsaWRhdG9yID0gcGFydFZhbGlkYXRpb25baWR4XTtcblxuICBpZiAodmFsaWRhdG9yICYmICghIHZhbGlkYXRvclswXS50ZXN0KHBhcnQpKSkge1xuICAgIGRlYnVnKHZhbGlkYXRvclsyXSArICcgcGFydCBmYWlsZWQgdmFsaWRhdGlvbjogJyArIHBhcnQpO1xuICAgIHJldHVybiBuZXcgRXJyb3IodmFsaWRhdG9yWzFdKTtcbiAgfVxufVxuIiwibW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihhLCBiKSB7XG4gIHJldHVybiBhcmd1bWVudHMubGVuZ3RoID4gMSA/IGEgPT09IGIgOiBmdW5jdGlvbihiKSB7XG4gICAgcmV0dXJuIGEgPT09IGI7XG4gIH07XG59O1xuIiwiLyoqXG4gICMjIGZsYXR0ZW5cblxuICBGbGF0dGVuIGFuIGFycmF5IHVzaW5nIGBbXS5yZWR1Y2VgXG5cbiAgPDw8IGV4YW1wbGVzL2ZsYXR0ZW4uanNcblxuKiovXG5cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24oYSwgYikge1xuICAvLyBpZiBhIGlzIG5vdCBhbHJlYWR5IGFuIGFycmF5LCBtYWtlIGl0IG9uZVxuICBhID0gQXJyYXkuaXNBcnJheShhKSA/IGEgOiBbYV07XG5cbiAgLy8gY29uY2F0IGIgd2l0aCBhXG4gIHJldHVybiBhLmNvbmNhdChiKTtcbn07IiwibW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihjb21wYXJhdG9yKSB7XG4gIHJldHVybiBmdW5jdGlvbihpbnB1dCkge1xuICAgIHZhciBvdXRwdXQgPSBbXTtcbiAgICBmb3IgKHZhciBpaSA9IDAsIGNvdW50ID0gaW5wdXQubGVuZ3RoOyBpaSA8IGNvdW50OyBpaSsrKSB7XG4gICAgICB2YXIgZm91bmQgPSBmYWxzZTtcbiAgICAgIGZvciAodmFyIGpqID0gb3V0cHV0Lmxlbmd0aDsgamotLTsgKSB7XG4gICAgICAgIGZvdW5kID0gZm91bmQgfHwgY29tcGFyYXRvcihpbnB1dFtpaV0sIG91dHB1dFtqal0pO1xuICAgICAgfVxuXG4gICAgICBpZiAoZm91bmQpIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIG91dHB1dFtvdXRwdXQubGVuZ3RoXSA9IGlucHV0W2lpXTtcbiAgICB9XG5cbiAgICByZXR1cm4gb3V0cHV0O1xuICB9O1xufSIsIi8qKlxuICAjIyBudWJcblxuICBSZXR1cm4gb25seSB0aGUgdW5pcXVlIGVsZW1lbnRzIG9mIHRoZSBsaXN0LlxuXG4gIDw8PCBleGFtcGxlcy9udWIuanNcblxuKiovXG5cbm1vZHVsZS5leHBvcnRzID0gcmVxdWlyZSgnLi9udWItYnknKShyZXF1aXJlKCcuL2VxdWFsaXR5JykpOyIsIi8qKlxuICAjIyBwbHVja1xuXG4gIEV4dHJhY3QgdGFyZ2V0ZWQgcHJvcGVydGllcyBmcm9tIGEgc291cmNlIG9iamVjdC4gV2hlbiBhIHNpbmdsZSBwcm9wZXJ0eVxuICB2YWx1ZSBpcyByZXF1ZXN0ZWQsIHRoZW4ganVzdCB0aGF0IHZhbHVlIGlzIHJldHVybmVkLlxuXG4gIEluIHRoZSBjYXNlIHdoZXJlIG11bHRpcGxlIHByb3BlcnRpZXMgYXJlIHJlcXVlc3RlZCAoaW4gYSB2YXJhcmdzIGNhbGxpbmdcbiAgc3R5bGUpIGEgbmV3IG9iamVjdCB3aWxsIGJlIGNyZWF0ZWQgd2l0aCB0aGUgcmVxdWVzdGVkIHByb3BlcnRpZXMgY29waWVkXG4gIGFjcm9zcy5cblxuICBfX05PVEU6X18gSW4gdGhlIHNlY29uZCBmb3JtIGV4dHJhY3Rpb24gb2YgbmVzdGVkIHByb3BlcnRpZXMgaXNcbiAgbm90IHN1cHBvcnRlZC5cblxuICA8PDwgZXhhbXBsZXMvcGx1Y2suanNcblxuKiovXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKCkge1xuICB2YXIgZmllbGRzID0gW107XG5cbiAgZnVuY3Rpb24gZXh0cmFjdG9yKHBhcnRzLCBtYXhJZHgpIHtcbiAgICByZXR1cm4gZnVuY3Rpb24oaXRlbSkge1xuICAgICAgdmFyIHBhcnRJZHggPSAwO1xuICAgICAgdmFyIHZhbCA9IGl0ZW07XG5cbiAgICAgIGRvIHtcbiAgICAgICAgdmFsID0gdmFsICYmIHZhbFtwYXJ0c1twYXJ0SWR4KytdXTtcbiAgICAgIH0gd2hpbGUgKHZhbCAmJiBwYXJ0SWR4IDw9IG1heElkeCk7XG5cbiAgICAgIHJldHVybiB2YWw7XG4gICAgfTtcbiAgfVxuXG4gIFtdLnNsaWNlLmNhbGwoYXJndW1lbnRzKS5mb3JFYWNoKGZ1bmN0aW9uKHBhdGgpIHtcbiAgICB2YXIgcGFydHMgPSB0eXBlb2YgcGF0aCA9PSAnbnVtYmVyJyA/IFsgcGF0aCBdIDogKHBhdGggfHwgJycpLnNwbGl0KCcuJyk7XG5cbiAgICBmaWVsZHNbZmllbGRzLmxlbmd0aF0gPSB7XG4gICAgICBuYW1lOiBwYXJ0c1swXSxcbiAgICAgIHBhcnRzOiBwYXJ0cyxcbiAgICAgIG1heElkeDogcGFydHMubGVuZ3RoIC0gMVxuICAgIH07XG4gIH0pO1xuXG4gIGlmIChmaWVsZHMubGVuZ3RoIDw9IDEpIHtcbiAgICByZXR1cm4gZXh0cmFjdG9yKGZpZWxkc1swXS5wYXJ0cywgZmllbGRzWzBdLm1heElkeCk7XG4gIH1cbiAgZWxzZSB7XG4gICAgcmV0dXJuIGZ1bmN0aW9uKGl0ZW0pIHtcbiAgICAgIHZhciBkYXRhID0ge307XG5cbiAgICAgIGZvciAodmFyIGlpID0gMCwgbGVuID0gZmllbGRzLmxlbmd0aDsgaWkgPCBsZW47IGlpKyspIHtcbiAgICAgICAgZGF0YVtmaWVsZHNbaWldLm5hbWVdID0gZXh0cmFjdG9yKFtmaWVsZHNbaWldLnBhcnRzWzBdXSwgMCkoaXRlbSk7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiBkYXRhO1xuICAgIH07XG4gIH1cbn07Il19
