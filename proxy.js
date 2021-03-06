
 /*
 * BtleJuice Proxy
 *
 * This module provides the Proxy class that may be used to create a link
 * between a dummy device and the real device.
 *
 * By doing so, characteristics operations (read, write, notify) are forwarded
 * to the real device allowing Man-in-the-Middle scenarii (including sniffing
 * and logging).
 *
 * Supported messages:
 *
 * - connect: asks the proxy to connect to a specific device and relay to it.
 * - scan_devices: asks the proxy to scan for reachable devices
 * - stop: asks the proxy to stop (scanning or relaying operations)
 * - write: write data to a characteristic
 * - read: read data from a characteristic
 * - notify: register for notification for a given characteristic
 *
 * Produced messages:
 * - hello: sent on client connection to notify it is ready to operate
 * - ready: sent when the proxy is connected to the target device,
 *                ready to relay.
 * - discover: sent to announce the discovery of a specific device.
 * - read: data read
 * - write: data write operation result
 * - notify: notify operation result
 **/

var async = require('async');
var events = require('events');
var noble = require('noble');
var util = require('util');
var colors = require('colors');
var server = require('socket.io');

var Proxy = function(options){

  /* Profiling related properties. */
  this.devices = {};

  /* BLE target. */
  this.device = null;
  this.target = null;
  this.state = 'disconnected';
  this.config = null;
  this.pendingActions = [];

  /* Websocket server options. */
  if (options && (options.port != undefined)) {
    this.port = options.port;
  } else {
    /* Default port. */
    this.port = 8000;
  }

  /* Create server. */
  this.server = new server();
  this.client = null;

  /* LE Adv report */
  this.le_adv_handler = null;
  this.watchdog = null;
};

/**
 * start
 *
 * Start the proxy.
 **/

Proxy.prototype.start = function(){
  /* Start server. */
  console.log(('[info] Server listening on port '+this.port).bold);

  /* Set connection handler. */
  this.server.on('connection', function(client){
    console.log(('[info] Client connected').green);
    this.client = client;

    /* Set config handler. */
    client.on('target', function(config){
      this.configure(config);
    }.bind(this));

    /* Set discovery handler. */
    client.on('scan_devices', function(){
      this.scanDevices();
    }.bind(this));

    /* Set the stop handler. */
    client.on('stop', function(){
      this.stop();
    }.bind(this));

    /* Set the status handler. */
    client.on('status', function(){
      this.notifyStatus();
    }.bind(this));

    client.on('disconnect', function(){
      this.onClientDisconnect();
    }.bind(this));

    /* Notify client. */
    this.send('hello');
  }.bind(this));

  /* Listen on this.port. */
  this.server.listen(this.port);
}

Proxy.prototype.onClientDisconnect = function(){
  console.log('[warning] client disconnected');
  this.client = null;
};

Proxy.prototype.send = function() {
  /* Forward to client if any. */
  if (this.client != null) {
    this.client.emit.apply(this.client, arguments);
  } else {
    console.log('[error] client disconnected.'.red);
  }
};

/**
 * configure
 *
 * Provides information about the target to connect to and initiates
 * the BLE connection to this target.
 **/

Proxy.prototype.configure = function(target){
  console.log('Configuring proxy ...'.bold);
  this.target = target.toLowerCase();

  /* If already connected to a target, drop the connection. */
  if (this.device != null) {
    /* Remove noble listeners. */
    noble.removeAllListeners('discover');

    /* Disconnect from device. */
    this.device.disconnect(function(){
        /* Reset services and characteristics. */
        this.nservices = 0;
        this.ncharacteristics = 0;
        this.services = null;

        /* Start target acquisition. */
        this.state = 'acquisition';
        this.acquireTarget();
      }.bind(this));
  } else {
    /* Start target acquisition. */
    this.state = 'acquisition';
    this.acquireTarget(null);
  }
}

/**
 * acquireTarget
 *
 * Scan for the specified target and launch connection when found.
 **/

Proxy.prototype.acquireTarget = function(config) {
  console.log(('[status] Acquiring target ' + this.target).bold);

  /* Track BLE advertisement reports. */
  if (this.le_adv_handler != null)
      noble._bindings._gap._hci.removeListener(
        'leAdvertisingReport',
        this.le_adv_handler
      )
  this.le_adv_handler = function(status, type, address, addressType, report, rssi){
    this.discoverDeviceAdv(address, report, rssi);
  }.bind(this);
  noble._bindings._gap._hci.on(
    'leAdvertisingReport',
    this.le_adv_handler
  );
  /*
  noble._bindings._gap._hci.on(
    'leAdvertisingReport',
    function(status, type, address, addressType, report, rssi){
      this.discoverDeviceAdv(address, report, rssi);
    }.bind(this));
  */
  /* Track BLE advertisement reports. */
  noble.on('discover', function(peripheral){
      if (peripheral.address.toLowerCase() === this.target.toLowerCase()) {
        noble.stopScanning();
        this.connectDevice(peripheral, config);
      }
    }.bind(this)
  );

  /* Start scanning when ble device is ready. */
  noble.startScanning();
};

/**
 * discoverDeviceAdv()
 *
 * Keep track of discovered raw devices' advertisement records.
 **/

Proxy.prototype.discoverDeviceAdv = function(bdaddr, report, rssi)  {
  if (!(bdaddr in this.devices) && bdaddr != null) {
    /* Save advertisement data. */
    this.devices[bdaddr] = {
      services: {},
      adv_records: report,
      scan_data: null,
      connected: false,
    };
  } else if (bdaddr in this.devices) {
    /* Save scan response. */
    this.devices[bdaddr].scan_data = report;
  }
};

Proxy.prototype.isAllDiscovered = function() {
  /* First, check if all services have been discovered. */
  for (var serviceUuid in this.discovered) {
    if (this.discovered[serviceUuid].done === false)
      return false;
  }

  /* Then check if all characteristics have been discovered. */
  for (var serviceUuid in this.discovered) {
    for (var characUuid in this.discovered[serviceUuid].characteristics) {
      //console.log(serviceUuid+':'+characUuid);
      if (this.discovered[serviceUuid].characteristics[characUuid] === false)
        return false;
    }
  }

  return true;
}


/**
 * connectDevice
 *
 * Connect to the target device and start services discovery.
 **/

Proxy.prototype.connectDevice = function(peripheral) {
  this.device = peripheral;
  this.discovered = {};
  this.services = {};

  /* Remove any connect callback (required by Noble) */
  this.device.removeAllListeners('connect');

  this.device.connect(function(error) {
      /* Setup  the disconnect handler. */
      peripheral.removeAllListeners('disconnect');
      peripheral.on('disconnect', function(){
        this.onDeviceDisconnected();
      }.bind(this));

      if (error == undefined) {
        /* Save device profile. */
        this.currentDevice = peripheral;
        this.devices[this.currentDevice.address].connected = true;
        this.devices[this.currentDevice.address].name = peripheral.advertisement.localName;

        /* Discover services ... */
        this.send('discover_services');

        this.state = 'connected';
        console.log(('[info] Proxy successfully connected to the real device').green);
        console.log(('[info] Discovering services and characteristics ...').bold);

        /* Characteristics discovery watchdog (20 seconds). */
        if (this.watchdog == null) {
          this.watchdog = setTimeout(function(){
            console.log('[error] discovery timed out, stopping proxy.');
            this.watchdog = null;
            this.stop();
          }.bind(this), 20000);
        }

        /* Connection OK, now discover services. */
        peripheral.discoverServices(null, function(error, services) {
          //console.log('services discovered');
          //console.log(services);
          if (error == undefined) {
            for (var service in services) {

              /* Excludes service UUIDs 1800 and 1801. */
              if (services[service].uuid == '1800') {
                continue;
              }
              if (services[service].uuid == '1801') {
                continue;
              }

              this.services[services[service].uuid] = {};
              this.discovered[services[service].uuid] = {
                done: false,
                characteristics: {}
              };

              var device = this.devices[this.currentDevice.address];
              device.services[services[service].uuid] = {};

              /* We are using a closure to keep a copy of the service's uuid. */
              services[service].discoverCharacteristics(null, (function(serviceUuid){
                return function(error, characs){

                  if (error == null) {
                    for (var c in characs) {
                      this.services[serviceUuid][characs[c].uuid] = characs[c];

                      /* Characteristic is not discovered by default. */
                      this.discovered[serviceUuid].characteristics[characs[c].uuid] = false;

                      /* Save characteristic. */
                      var device = this.devices[this.currentDevice.address];
                      var _service = device.services[serviceUuid];
                      _service[characs[c].uuid] = {
                        uuid: characs[c].uuid,
                        properties: characs[c].properties,
                        descriptors: [],
                      };
                    this.discovered[serviceUuid].done = true;
                      characs[c].discoverDescriptors((function(t, service, charac){
                        return function(error, descriptors) {
                          if (error == undefined) {
                            var device = t.devices[t.currentDevice.address];
                            var _charac = device.services[service][charac];
                            for (var desc in descriptors) {
                              _charac.descriptors.push(descriptors[desc].uuid);
                            }
                            t.onCharacteristicDiscovered(service, charac);
                          } else {
                            console.log('[error] cannot discover descriptor for service '+ service+':'+charac);
                          }
                        }
                      })(this, serviceUuid, characs[c].uuid));
                    }
                  } else {
                    console.log(('[error] cannot discover characteristic ' + charac).red)
                  }
                };
              })(services[service].uuid).bind(this));
            }
          } else {
            console.log(('[error] cannot discover service ' + serviceUuid).red);
          }
        }.bind(this));
      } else {
        this.send('ready', false);
      }
    }.bind(this)
  );
};

Proxy.prototype.onDeviceDisconnected = function(){
  console.log('[error] Remote device has just disconnected'.red);

  /* Defuse watchdog if any. */
  if (this.watchdog != null) {
    console.log('disarming watchdog');
    clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  /* Reset services and characteristics. */
  this.services = null;
  this.discovered = {};

  /* Mark as disconnected. */
  this.state = 'disconnected';
  this.device = null;
};

Proxy.prototype.formatProfile = function() {
  /* Create our serialized data. */
  var device_info = {};
  device_info['ad_records'] = this.devices[this.target].adv_records.toString('hex');
  if (this.devices[this.target].scan_data != null)
    device_info['scan_data'] = this.devices[this.target].scan_data.toString('hex');
  else
    device_info['scan_data'] = '';
  device_info['name'] = this.devices[this.target].name;
  device_info['services'] = [];
  device_info['address'] = this.target;
  for (var _service in this.devices[this.target].services) {
    var _chars = this.devices[this.target].services[_service];

    var service = {};
    service['uuid'] = _service;
    service['characteristics'] = [];
    for (var device_char in _chars) {
      var char = {};
      char['uuid'] = _chars[device_char]['uuid'];
      char['properties'] = _chars[device_char]['properties'];
      char['descriptors'] = _chars[device_char]['descriptors'];
      service['characteristics'].push(char);
    }
    device_info['services'].push(service);
  }
  return device_info;
}

Proxy.prototype.onDiscoverCharacteristic = function(peripheral, service, charac, callback) {
  charac.discoverDescriptors((function(_this, peripheral, service, charac, callback){
    return function(error, descriptors) {
      callback();
    }
  })(this, peripheral, service, charac, callback));
};

Proxy.prototype.onCharacteristicDiscovered = function(service, characteristic) {
  this.discovered[service].characteristics[characteristic] = true;
  if (this.isAllDiscovered()) {

    /* Defuse watchdog if any. */
    if (this.watchdog != null) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }

    this.setGattHandlers();
    this.state = 'forwarding';
    this.send('profile', this.formatProfile());
    this.send('ready', true);
    console.log('[status] Proxy configured and ready to relay !'.green);
  }
};

/**
 * setGattHandlers
 *
 * Install basic GATT operations handlers.
 **/

Proxy.prototype.setGattHandlers = function(){
  /* Remove previous listeners. */
  this.client.removeAllListeners('ble_read');
  this.client.removeAllListeners('ble_write');
  this.client.removeAllListeners('ble_notify');

  /* Install read handler. */
  this.client.on('ble_read', function(service, characteristic, offset){
    /* Force lower case. */
    service = service.toLowerCase();
    characteristic = characteristic.toLowerCase();

    /* Read characteristic. */
    if (this.services != null) {
      this.services[service][characteristic].read(function(error, data){
        this.send('ble_read_resp', service, characteristic, new Buffer(data));
      }.bind(this));
    }
  }.bind(this));

  /* Install write handler. */
  this.client.on('ble_write', function(service, characteristic, data, withoutResponse){
    /* Force lower case. */
    service = service.toLowerCase();
    characteristic = characteristic.toLowerCase();

    /* Write characteristic. */
    if (this.services != null) {
      this.services[service][characteristic].write(data, withoutResponse, function(error){
        this.send('ble_write_resp', service, characteristic, error);
      }.bind(this));
    }
  }.bind(this));

  /* Install notify handler. */
  this.client.on('ble_notify', function(service, characteristic, enable){
    if (this.services != null) {
      /* Register our automatic read handler. */
      this.services[service][characteristic].removeAllListeners('data');
      this.services[service][characteristic].on('data', function(data, isnotif)  {
        this.send('ble_data', service, characteristic, data, isnotif);
      }.bind(this));

      /* Subscribe for notification. */
      this.services[service][characteristic].notify(enable, function(error)  {
        this.send('ble_notify_resp', service, characteristic, error);
      }.bind(this));
    }
  }.bind(this));
};

Proxy.prototype.scanDevices = function(){
  if (this.state == 'connected') {
    noble.disconnect();
  }

  /* Get discovery announces. */
  noble.removeAllListeners('discover');
  noble.on('discover', function(peripheral){
      /* Forward discovery message to consumer. */
      this.send('discover', peripheral.address, peripheral.advertisement.localName, peripheral.rssi);
    }.bind(this)
  );

  this.state = 'scanning';
  noble.startScanning();
};

Proxy.prototype.stop = function(){
  console.log('[i] Stopping current proxy.'.bold);

  /* If already connected to a target, drop the connection. */
  if (this.device != null) {
    /* Disconnect from device. */
    this.device.disconnect(function(){
        /* Reset services and characteristics. */
        this.services = null;
        this.discovered = null;

        /* Mark as disconnected. */
        this.state = 'disconnected';
        this.device = null;
      }.bind(this));
  }

  /* Reset. */
  this.state = 'disconnected';
  this.services = null;
  this.discovered = null;

  /* Notify client if any. */
  if (this.client != null) {
    this.send('stopped');
  }
};

Proxy.prototype.notifyStatus = function(){
  switch(this.state) {
    case 'connected':
      this.send('status', 'connected');
      break;
    case 'disconnected':
      this.send('status', 'ready');
      break;
    case 'scanning':
      this.send('status', 'scanning');
      break;
    default:
      this.send('status', 'busy');
      break;
  };
}

if (!module.parent) {
  var proxy = new Proxy(null);
  proxy.start();
} else {
  module.exports = Proxy;
}
