/*
Indigo platform shim for HomeBridge
Written by Mike Riccio (https://github.com/webdeck/homebridge-indigo)
See http://www.indigodomo.com/ for more info on Indigo
See http://forums.indigodomo.com/viewtopic.php?f=9&t=15008 for installation instructions

Configuration example for your Homebridge config.json:

"platforms": [
    {
        "platform": "Indigo",
        "name": "My Indigo Server",
        "protocol": "http",
        "host": "127.0.0.1",
        "port": "8176",
        "path": "",
        "username": "myusername",
        "password": "mypassword",
        "includeActions": true,
        "includeIds": [ "12345", "67890" ],
        "excludeIds": [ "98765", "43210" ],
        "treatAsSwitchIds": [ "13579", "24680" ],
        "treatAsLockIds": [ "112233", "445566" ],
        "treatAsDoorIds": [ "224466", "664422" ],
        "treatAsGarageDoorIds": [ "223344", "556677" ],
        "treatAsWindowIds": [ "123123", "456456" ],
        "treatAsWindowCoveringIds": [ "345345", "678678" ],
        "thermostatsInCelsius": false,
        "accessoryNamePrefix": "",
        "listenPort": 8177
    }
]

Fields:
    "platform": Must always be "Indigo" (required)
    "name": Can be anything (required)
    "protocol": "http" or "https" (optional, defaults to "http" if not specified)
    "host": Hostname or IP Address of your Indigo web server (required)
    "port": Port number of your Indigo web server (optional, defaults to "8176" if not specified)
    "path": The path to the root of your Indigo web server (optional, defaults to "" if not specified, only needed if you have a proxy in front of your Indigo web server)
    "username": Username to log into Indigo web server, if applicable (optional)
    "password": Password to log into Indigo web server, if applicable (optional)
    "includeActions": If true, creates HomeKit switches for your actions (optional, defaults to false)
    "includeIds": Array of Indigo IDs to include (optional - if provided, only these Indigo IDs will map to HomeKit devices)
    "excludeIds": Array of Indigo IDs to exclude (optional - if provided, these Indigo IDs will not be mapped to HomeKit devices)
    "treatAsSwitchIds": Array of Indigo IDs to treat as switches (instead of lightbulbs) - devices must support on/off to qualify
    "treatAsLockIds": Array of Indigo IDs to treat as locks (instead of lightbulbs) - devices must support on/off to qualify (on = locked)
    "treatAsDoorIds": Array of Indigo IDs to treat as doors (instead of lightbulbs) - devices must support on/off to qualify (on = open)
    "treatAsGarageDoorIds": Array of Indigo IDs to treat as garage door openers (instead of lightbulbs) - devices must support on/off to qualify (on = open)
    "treatAsWindowIds": Array of Indigo IDs to treat as windows (instead of lightbulbs) - devices must support on/off to qualify (on = open)
    "treatAsWindowCoveringIds": Array of Indigo IDs to treat as window coverings (instead of lightbulbs) - devices must support on/off to qualify (on = open)
    "thermostatsInCelsius": If true, thermostats in Indigo are reporting temperatures in celsius (optional, defaults to false)
    "accessoryNamePrefix": Prefix all accessory names with this string (optional, useful for testing)
    "listenPort": homebridge-indigo will listen on this port for device state updates from Indigo (requires compatible Indigo plugin) (optional, defaults to not listening)

Note that if you specify both "includeIds" and "excludeIds", then only the IDs that are in
"includeIds" and missing from "excludeIds" will be mapped to HomeKit devices.  Typically,
you would only specify one or the other, not both of these lists.  If you just want to
expose everything, then omit both of these keys from your configuration.

Also note that any Indigo devices or actions that have Remote Display unchecked in Indigo
will NOT be exposed to HomeKit, because Indigo excludes those devices from its RESTful API.
*/

var request = require("request");
var async = require("async");
var express = require("express");
var inherits = require('util').inherits;
var Service, Characteristic, Accessory, uuid;

module.exports = function(homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    Accessory = homebridge.hap.Accessory;
    uuid = homebridge.hap.uuid;

    fixInheritance(IndigoAccessory, Accessory);
    fixInheritance(IndigoSwitchAccessory, IndigoAccessory);
    fixInheritance(IndigoLockAccessory, IndigoAccessory);
    fixInheritance(IndigoPositionAccessory, IndigoAccessory);
    fixInheritance(IndigoDoorAccessory, IndigoPositionAccessory);
    fixInheritance(IndigoWindowAccessory, IndigoPositionAccessory);
    fixInheritance(IndigoWindowCoveringAccessory, IndigoPositionAccessory);
    fixInheritance(IndigoGarageDoorAccessory, IndigoAccessory);
    fixInheritance(IndigoLightAccessory, IndigoAccessory);
    fixInheritance(IndigoFanAccessory, IndigoAccessory);
    fixInheritance(IndigoThermostatAccessory, IndigoAccessory);
    fixInheritance(IndigoActionAccessory, IndigoAccessory);

    homebridge.registerPlatform("homebridge-indigo", "Indigo", IndigoPlatform);
};

// Necessary because Accessory is defined after we have defined all of our classes
function fixInheritance(subclass, superclass) {
    var proto = subclass.prototype;
    inherits(subclass, superclass);
    subclass.prototype.parent = superclass.prototype;
    for (var mn in proto) {
        subclass.prototype[mn] = proto[mn];
    }
}


// Initialize the homebridge platform
// log: the logger
// config: the contents of the platform's section of config.json
function IndigoPlatform(log, config) {
    this.log = log;

    // We use a queue to serialize all the requests to Indigo
    this.requestQueue = async.queue(
        function(options, callback) {
            this.log("Indigo request: %s", options.url);
            request(options, callback);
        }.bind(this)
    );

    this.foundAccessories = [];
    this.accessoryMap = new Map();

    // Parse all the configuration options
    var protocol = "http";
    if (config.protocol) {
        protocol = config.protocol;
    }

    var port = "8176";
    if (config.port) {
        port = config.port;
    }

    this.path = "";
    if (config.path) {
        this.path = config.path;
        // Make sure path doesn't end with a slash
        if (this.path.length > 0 && this.path.charAt(this.path.length -1) == '/') {
            this.path = this.path.substr(0, this.path.length - 1);
        }
        // Make sure path begins with a slash
        if (this.path.length > 0 && this.path.charAt(0) != "/") {
            this.path = "/" + this.path;
        }
        this.log("Path prefix is %s", this.path);
    }

    this.baseURL = protocol + "://" + config.host + ":" + port;
    this.log("Indigo base URL is %s", this.baseURL);

    if (config.username && config.password) {
        this.auth = {
            user: config.username,
            pass: config.password,
            sendImmediately: false
        };
    }

    this.includeActions = config.includeActions;
    this.includeIds = config.includeIds;
    this.excludeIds = config.excludeIds;
    this.treatAsSwitchIds = config.treatAsSwitchIds;
    this.treatAsLockIds = config.treatAsLockIds;
    this.treatAsDoorIds = config.treatAsDoorIds;
    this.treatAsGarageDoorIds = config.treatAsGarageDoorIds;
    this.treatAsWindowIds = config.treatAsWindowIds;
    this.treatAsWindowCoveringIds = config.treatAsWindowCoveringIds;
    this.thermostatsInCelsius = config.thermostatsInCelsius;

    if (config.accessoryNamePrefix) {
        this.accessoryNamePrefix = config.accessoryNamePrefix;
    } else {
        this.accessoryNamePrefix = "";
    }

    // Start the accessory update listener, if configured
    if (config.listenPort) {
        this.app = express();
        this.app.get("/devices/:id", this.updateAccessory.bind(this));
        this.app.listen(config.listenPort,
            function() {
                this.log("Listening on port %d", config.listenPort);
            }.bind(this)
        );
    }
}

// Invokes callback(accessories[]) with all of the discovered accessories for this platform
IndigoPlatform.prototype.accessories = function(callback) {
    var requestURLs = [ this.path + "/devices.json/" ];
    if (this.includeActions) {
        requestURLs.push(this.path + "/actions.json/");
    }

    async.eachSeries(requestURLs,
        function(requestURL, asyncCallback) {
            this.discoverAccessories(requestURL, asyncCallback);
        }.bind(this),
        function (asyncError) {
            if (asyncError) {
                this.log(asyncError);
            }

            if (this.foundAccessories.length > 99) {
                this.log("*** WARNING *** you have %s accessories.",
                         this.foundAccessories.length);
                this.log("*** Limiting to the first 99 discovered. ***");
                this.log("*** See README.md for how to filter your list. ***");
                this.foundAccessories = this.foundAccessories.slice(0, 99);
            }

            this.log("Created %s accessories", this.foundAccessories.length);
            callback(this.foundAccessories.sort(
                function (a, b) {
                    return (a.name > b.name) - (a.name < b.name);
                }
            ));
        }.bind(this)
    );
};

// Discovers all of the accessories under a root Indigo RESTful API node (e.g. devices, actions, etc.)
// Populates this.foundAccessories and this.accessoryMap
// requestURL: the Indigo RESTful API URL to query
// callback: invokes callback(error) when all accessories have been discovered; error is undefined if no error occurred
IndigoPlatform.prototype.discoverAccessories = function(requestURL, callback) {
    this.indigoRequestJSON(requestURL, "GET", null,
        function(error, json) {
            if (error) {
                callback(error);
            }
            else {
                async.eachSeries(json, this.addAccessory.bind(this),
                    function(asyncError) {
                        if (asyncError) {
                            callback(asyncError);
                        } else {
                            callback();
                        }
                    }
                );
            }
        }.bind(this),
        // jsonFixer: Indigo has a bug that if the first item has remote display
        // disabled, the returned JSON array has an extra comma at the beginning
        function(body) {
            var firstComma = body.indexOf(",");
            if (firstComma > 0 && firstComma < 5) {
                body = body.substr(0, firstComma) + body.substr(firstComma + 1);
            }
            return (body);
        }
    );
};

// Adds an IndigoAccessory object to this.foundAccessories and this.accessoryMap
// item: JSON describing the device, as returned by the root of the Indigo RESTful API (e.g. /devices.json/)
// callback: invokes callback(error), error is always undefined as we want to ignore errors
// Note: does not create and add the IndigoAccessory if it is an unknoen type or is excluded by the config
IndigoPlatform.prototype.addAccessory = function(item, callback) {
    // Get the details of the item, using its provided restURL
    this.indigoRequestJSON(item.restURL, "GET", null,
        function(error, json) {
            if (error) {
                this.log("Ignoring accessory %s due to error", item.restURL);
                callback();
            }
            else {
                // Actions are missing a type field
                if (json.restParent == "actions") {
                    json.type = "Action";
                }
                this.log("Discovered %s (ID %s): %s", json.type, json.id, json.name);
                if (this.includeItemId(json.id)) {
                    var accessory = this.createAccessoryFromJSON(item.restURL, json);
                    if (accessory) {
                        this.foundAccessories.push(accessory);
                        this.accessoryMap.set(String(json.id), accessory);
                    } else {
                        this.log("Ignoring unknown accessory type %s", json.type);
                    }
                }
                else {
                    this.log("Ignoring excluded ID %s", json.id);
                }
                callback();
            }
        }.bind(this)
    );
};

// Returns true if the item id should be included in the accessory list
// id: the Indigo ID of the device/action
IndigoPlatform.prototype.includeItemId = function(id) {
    if (this.includeIds && (this.includeIds.indexOf(String(id)) < 0)) {
        return false;
    }

    if (this.excludeIds && (this.excludeIds.indexOf(String(id)) >= 0)) {
        return false;
    }

    return true;
};

// Makes a request to Indigo using the RESTful API
// path: the path of the request, relative to the base URL in the configuration, starting with a /
// method: the type of HTTP request to make (e.g. GET, POST, etc.)
// qs: the query string to include in the request (optional)
// callback: invokes callback(error, response, body) with the result of the HTTP request
IndigoPlatform.prototype.indigoRequest = function(path, method, qs, callback) {
    // seems to be a bug in request that if followRedirect is false and auth is
    // required, it crashes because redirects is missing, so I include it here
    var options = {
        url: this.baseURL + path,
        method: method,
        followRedirect: false,
        redirects: []
    };
    if (this.auth) {
        options.auth = this.auth;
    }
    if (qs) {
        options.qs = qs;
    }

    // All requests to Indigo are serialized, so that there is no more than one outstanding request at a time
    this.requestQueue.push(options, callback);
};

// Makes a request to Indigo using the RESTful API and parses the JSON response
// path: the path of the request, relative to the base URL in the configuration, starting with a /
// method: the type of HTTP request to make (e.g. GET, POST, etc.)
// qs: the query string to include in the request (optional)
// callback: invokes callback(error, json) with the parsed JSON object returned by the HTTP request
// jsonFixer: optional function which manipulates the HTTP response body before attempting to parse the JSON
//            this is used to work around bugs in Indigo's RESTful API responses that cause invalid JSON
IndigoPlatform.prototype.indigoRequestJSON = function(path, method, qs, callback, jsonFixer) {
    this.indigoRequest(path, method, qs,
        function(error, response, body) {
            if (error) {
                var msg = "Error for Indigo request " + path + ": " + error;
                this.log(msg);
                callback(msg);
            }
            else {
                if (jsonFixer) {
                    body = jsonFixer(body);
                }
                var json;
                try {
                    var json = JSON.parse(body);
                } catch (e) {
                    var msg2 = "Error parsing Indigo response for " + path +
                               "\nException: " + e + "\nResponse: " + body;
                    this.log(msg2);
                    callback(msg2);
                    return;
                }
                callback(undefined, json);
            }
        }.bind(this)
    );
};

// Returns subclass of IndigoAccessory based on json, or null if unsupported type
// deviceURL: the path of the RESTful call for this device, relative to the base URL in the configuration, starting with a /
// json: the json that describes this device
IndigoPlatform.prototype.createAccessoryFromJSON = function(deviceURL, json) {
    if (json.restParent == "actions") {
        return new IndigoActionAccessory(this, deviceURL, json);
    } else if (json.typeSupportsOnOff && this.treatAsSwitchIds &&
               (this.treatAsSwitchIds.indexOf(String(json.id)) >= 0)) {
        return new IndigoSwitchAccessory(this, deviceURL, json);
    } else if (json.typeSupportsOnOff && this.treatAsLockIds &&
               (this.treatAsLockIds.indexOf(String(json.id)) >= 0)) {
        return new IndigoLockAccessory(this, deviceURL, json);
    } else if (json.typeSupportsOnOff && this.treatAsDoorIds &&
               (this.treatAsDoorIds.indexOf(String(json.id)) >= 0)) {
        return new IndigoDoorAccessory(this, deviceURL, json);
    } else if (json.typeSupportsOnOff && this.treatAsGarageDoorIds &&
               (this.treatAsGarageDoorIds.indexOf(String(json.id)) >= 0)) {
        return new IndigoGarageDoorAccessory(this, deviceURL, json);
    } else if (json.typeSupportsOnOff && this.treatAsWindowIds &&
               (this.treatAsWindowIds.indexOf(String(json.id)) >= 0)) {
        return new IndigoWindowAccessory(this, deviceURL, json);
    } else if (json.typeSupportsOnOff && this.treatAsWindowCoveringIds &&
               (this.treatAsWindowCoveringIds.indexOf(String(json.id)) >= 0)) {
        return new IndigoWindowCoveringAccessory(this, deviceURL, json);
    } else if (json.typeSupportsHVAC) {
        return new IndigoThermostatAccessory(this, deviceURL, json, this.thermostatsInCelsius);
    } else if (json.typeSupportsSpeedControl) {
        return new IndigoFanAccessory(this, deviceURL, json);
    } else if (json.typeSupportsDim || json.typeSupportsOnOff) {
        return new IndigoLightAccessory(this, deviceURL, json);
    } else {
        return null;
    }
};

// Invoked by a request on listenPort of /devices/:id
// If the ID corresponds to an accessory, invokes refresh(callback) on that accessory
// Sends a 200 HTTP response if successful, a 404 if the ID is not found, or a 500 if there is an error
IndigoPlatform.prototype.updateAccessory = function(request, response) {
    var id = String(request.params.id);
    this.log("Got update request for device ID %s", id);
    var accessory = this.accessoryMap.get(id);
    if (accessory) {
        accessory.refresh(function(error) {
            if (error) {
                this.log("Error updating device ID %s: %s", id, error);
                response.sendStatus(500);
            } else {
                response.sendStatus(200);
            }
        }.bind(this));
    }
    else {
        response.sendStatus(404);
    }
};


//
// Generic Indigo Accessory
//
// platform: the HomeKit platform
// deviceURL: the path of the RESTful call for this device, relative to the base URL in the configuration, starting with a /
// json: the json that describes this device
//
function IndigoAccessory(platform, deviceURL, json) {
    this.platform = platform;
    this.log = platform.log;
    this.deviceURL = deviceURL;

    this.updateFromJSON(json);

    Accessory.call(this, this.name, uuid.generate(String(this.id)));

    var s = this.getService(Service.AccessoryInformation);
    s.setCharacteristic(Characteristic.Manufacturer, "Indigo")
        .setCharacteristic(Characteristic.SerialNumber, String(this.id));

    if (this.type) {
        s.setCharacteristic(Characteristic.Model, this.type);
    }

    if (this.versByte) {
        s.setCharacteristic(Characteristic.FirmwareRevision, this.versByte);
    }
}

// A set context that indicates this is from an update made by this plugin, so do not call the Indigo RESTful API with a put request
IndigoAccessory.REFRESH_CONTEXT = 'refresh';


// Returns the HomeKit services that this accessory supports
IndigoAccessory.prototype.getServices = function() {
    return this.services;
};

// Updates the Accessory's properties with values from JSON from the Indigo RESTful API
// json: JSON object from the Indigo RESTful API
// updateCallback: optional, invokes updateCallback(propertyName, propertyValue) for each property that has changed value
IndigoAccessory.prototype.updateFromJSON = function(json, updateCallback) {
    for (var prop in json) {
        if (prop != "name" && json.hasOwnProperty(prop)) {
            if (json[prop] != this[prop]) {
                this[prop] = json[prop];
                if (updateCallback) {
                    updateCallback(prop, json[prop]);
                }
            }
        }
    }

    // Allows us to change the name of accessories - useful for testing
    if (json.name !== undefined) {
        this.name = this.platform.accessoryNamePrefix + String(json.name);
    }
};

// Calls the Indigo RESTful API to get the latest state for this Accessory, and updates the Accessory's properties to match
// callback: invokes callback(error), error is undefined if no error occurred
// updateCallback: optional, invokes updateCallback(propertyName, propertyValue) for each property that has changed value
IndigoAccessory.prototype.getStatus = function(callback, updateCallback) {
    this.platform.indigoRequestJSON(this.deviceURL, "GET", null,
        function(error, json) {
            if (error) {
                callback(error);
            } else {
                this.updateFromJSON(json, updateCallback);
                callback();
            }
        }.bind(this)
    );
};

// Calls the Indigo RESTful API to alter the state of this Accessory, and updates the Accessory's properties to match
// qs: the query string parameters to send to the Indigo RESTful API via a PUT request
// callback: invokes callback(error), error is undefined if no error occurred
// updateCallback: optional, invokes updateCallback(propertyName, propertyValue) for each property that has changed value
IndigoAccessory.prototype.updateStatus = function(qs, callback, updateCallback) {
    this.log("updateStatus of %s: %s", this.name, JSON.stringify(qs));
    this.platform.indigoRequest(this.deviceURL, "PUT", qs,
        function(error, response, body) {
            if (error) {
                callback(error);
            } else {
                this.getStatus(callback, updateCallback);
            }
        }.bind(this)
    );
};
// Calls the Indigo RESTful API to get the latest state of this Accessory, and updates the Accessory's properties to match
// key: the property we are interested in
// callback: invokes callback(error, value), error is undefined if no error occurred, value is the value of the property named key
IndigoAccessory.prototype.query = function(key, callback) {
    this.getStatus(
        function(error) {
            if (error) {
                callback(error);
            } else {
                this.log("%s: query(%s) => %s", this.name, key, this[key]);
                callback(undefined, this[key]);
            }
        }.bind(this)
    );
};

// Calls the Indigo RESTful API to get the latest state of this Accessory, and updates the Accessory's properties to match
// Invokes the Accessory's update_KEY function for each property KEY where the value has changed from the prior cached state
// If the Accessory does not have an update_KEY function for a given KEY, it is safely ignored
// This is used when we are listening on the listenPort for notifications from Indigo about devices that have changed state
// TODO: A more elegant way to map HomeKit Characteristics and values to Indigo JSON keys and values
// callback: invokes callback(error), error is undefined if no error occurred
IndigoAccessory.prototype.refresh = function(callback) {
    this.log("%s: refresh()", this.name);
    this.getStatus(callback,
        function(prop, value) {
            updateFunction = "update_" + prop;
            if (this[updateFunction]) {
                this.log("%s: %s(%s)", this.name, updateFunction, value);
                this[updateFunction](value);
            }
        }.bind(this)
    );
};

// Most accessories support on/off, so we include helper functions to get/set onState here

// Get the current on/off state of the accessory
// callback: invokes callback(error, onState)
//           error: error message or undefined if no error
//           onState: true if device is on, false otherwise
IndigoAccessory.prototype.getOnState = function(callback) {
    if (this.typeSupportsOnOff) {
        this.getStatus(
            function(error) {
                if (error) {
                    callback(error);
                } else {
                    var onState = (this.isOn) ? true : false;
                    this.log("%s: getOnState() => %s", this.name, onState);
                    callback(undefined, onState);
                }
            }.bind(this)
        );
    }
};

// Set the current on/off state of the accessory
// onState: true if on, false otherwise
// callback: invokes callback(error), error is undefined if no error occurred
// context: if equal to IndigoAccessory.REFRESH_CONTEXT, will not call the Indigo RESTful API to update the device, otherwise will
IndigoAccessory.prototype.setOnState = function(onState, callback, context) {
    this.log("%s: setOnState(%s)", this.name, onState);
    if (context == IndigoAccessory.REFRESH_CONTEXT) {
        callback();
    } else if (this.typeSupportsOnOff) {
        this.updateStatus({ isOn: (onState) ? 1 : 0 }, callback);
    } else {
        callback("Accessory does not support on/off");
    }
};


//
// Indigo Switch Accessory - Represents an on/off switch
//
// platform: the HomeKit platform
// deviceURL: the path of the RESTful call for this device, relative to the base URL in the configuration, starting with a /
// json: the json that describes this device
//
function IndigoSwitchAccessory(platform, deviceURL, json) {
    IndigoAccessory.call(this, platform, deviceURL, json);

    var s = this.addService(new Service.Switch(this.name));
    s.getCharacteristic(Characteristic.On)
        .on('get', this.getOnState.bind(this))
        .on('set', this.setOnState.bind(this));
}

// Update HomeKit state to match state of Indigo's isOn property
// isOn: new value of isOn property
IndigoSwitchAccessory.prototype.update_isOn = function(isOn) {
    var onState = (isOn) ? true : false;
    this.getService(Service.Switch)
        .getCharacteristic(Characteristic.On)
        .setValue(onState, undefined, IndigoAccessory.REFRESH_CONTEXT);
};


//
// Indigo Lock Accessory - Represents a lock mechanism
//
// platform: the HomeKit platform
// deviceURL: the path of the RESTful call for this device, relative to the base URL in the configuration, starting with a /
// json: the json that describes this device
//
function IndigoLockAccessory(platform, deviceURL, json) {
    IndigoAccessory.call(this, platform, deviceURL, json);

    var s = this.addService(new Service.LockMechanism(this.name));
    s.getCharacteristic(Characteristic.LockCurrentState)
        .on('get', this.getLockCurrentState.bind(this));

    s.getCharacteristic(Characteristic.LockTargetState)
        .on('get', this.getLockTargetState.bind(this))
        .on('set', this.setLockTargetState.bind(this));
}

// Get the current lock state of the accessory
// callback: invokes callback(error, lockState)
//           error: error message or undefined if no error
//           lockState: Characteristic.LockCurrentState.SECURED (device on) or Characteristic.LockCurrentState.UNSECURED (device off)
IndigoLockAccessory.prototype.getLockCurrentState = function(callback) {
    if (this.typeSupportsOnOff) {
        this.getStatus(
            function(error) {
                if (error) {
                    callback(error);
                } else {
                    var lockState = (this.isOn) ? Characteristic.LockCurrentState.SECURED : Characteristic.LockCurrentState.UNSECURED;
                    this.log("%s: getLockCurrentState() => %s", this.name, lockState);
                    callback(undefined, lockState);
                }
            }.bind(this)
        );
    }
};

// Get the target lock state of the accessory
// callback: invokes callback(error, lockState)
//           error: error message or undefined if no error
//           lockState: Characteristic.LockTargetState.SECURED (device on) or Characteristic.LockTargetState.UNSECURED (device off)
IndigoLockAccessory.prototype.getLockTargetState = function(callback) {
    if (this.typeSupportsOnOff) {
        this.getStatus(
            function(error) {
                if (error) {
                    callback(error);
                } else {
                    var lockState = (this.isOn) ? Characteristic.LockTargetState.SECURED : Characteristic.LockTargetState.UNSECURED;
                    this.log("%s: getLockTargetState() => %s", this.name, lockState);
                    callback(undefined, lockState);
                }
            }.bind(this)
        );
    }
};

// Set the target lock state of the accessory
// lockState: Characteristic.LockTargetState.SECURED (device on) or Characteristic.LockTargetState.UNSECURED (device off)
// callback: invokes callback(error), error is undefined if no error occurred
// context: if equal to IndigoAccessory.REFRESH_CONTEXT, will not call the Indigo RESTful API to update the device, and will not update LockCurrentState
//          otherwise, calls the Indigo RESTful API and also updates LockCurrentState to match after a one second delay
IndigoLockAccessory.prototype.setLockTargetState = function(lockState, callback, context) {
    this.log("%s: setLockTargetState(%s)", this.name, lockState);
    if (context == IndigoAccessory.REFRESH_CONTEXT) {
        callback();
    } else if (this.typeSupportsOnOff) {
        this.updateStatus({ isOn: (lockState == Characteristic.LockTargetState.SECURED) ? 1 : 0 }, callback);
        // Update current state to match target state
        setTimeout(
            function() {
                this.getService(Service.LockMechanism)
                    .getCharacteristic(Characteristic.LockCurrentState)
                    .setValue((lockState == Characteristic.LockTargetState.SECURED) ?
                                Characteristic.LockCurrentState.SECURED : Characteristic.LockCurrentState.UNSECURED,
                                undefined, IndigoAccessory.REFRESH_CONTEXT);
            }.bind(this),
        1000);
    } else {
        callback("Accessory does not support on/off");
    }
};

// Update HomeKit state to match state of Indigo's isOn property
// isOn: new value of isOn property
IndigoLockAccessory.prototype.update_isOn = function(isOn) {
    var lockState = (isOn) ? Characteristic.LockCurrentState.SECURED : Characteristic.LockCurrentState.UNSECURED;
    this.getService(Service.LockMechanism)
        .getCharacteristic(Characteristic.LockCurrentState)
        .setValue(lockState, undefined, IndigoAccessory.REFRESH_CONTEXT);

    lockState = (isOn) ? Characteristic.LockTargetState.SECURED : Characteristic.LockTargetState.UNSECURED;
    this.getService(Service.LockMechanism)
        .getCharacteristic(Characteristic.LockTargetState)
        .setValue(lockState, undefined, IndigoAccessory.REFRESH_CONTEXT);
};


//
// Indigo Position Accessory (Door, Window, or Window Covering)
//
// platform: the HomeKit platform
// deviceURL: the path of the RESTful call for this device, relative to the base URL in the configuration, starting with a /
// json: the json that describes this device
// service: the HomeKit service
//
function IndigoPositionAccessory(platform, deviceURL, json, service) {
    IndigoAccessory.call(this, platform, deviceURL, json);

    var s = this.addService(service);
    this.service = s;
    s.getCharacteristic(Characteristic.CurrentPosition)
        .on('get', this.getPosition.bind(this));

    s.getCharacteristic(Characteristic.PositionState)
        .on('get', this.getPositionState.bind(this));

    s.getCharacteristic(Characteristic.TargetPosition)
        .on('get', this.getPosition.bind(this))
        .on('set', this.setTargetPosition.bind(this));
}

// Get the position of the accessory
// callback: invokes callback(error, position)
//           error: error message or undefined if no error
//           position: if device supports brightness, will return the brightness value; otherwise on=100 and off=0
IndigoPositionAccessory.prototype.getPosition = function(callback) {
    if (this.typeSupportsOnOff || this.typeSupportsDim) {
        this.getStatus(
            function(error) {
                if (error) {
                    callback(error);
                } else {
                    var position = (this.isOn) ? 100 : 0;
                    if (this.typeSupportsDim) {
                        position = this.brightness;
                    }
                    this.log("%s: getPosition() => %s", this.name, position);
                    callback(undefined, position);
                }
            }.bind(this)
        );
    }
};

// Get the position state of the accessory
// callback: invokes callback(error, position)
//           error: error message or undefined if no error
//           positionState: always Characteristic.PositionState.STOPPED
IndigoPositionAccessory.prototype.getPositionState = function(callback) {
    if (this.typeSupportsOnOff) {
        this.log("%s: getPositionState() => %s", this.name, Characteristic.PositionState.STOPPED);
        callback(undefined, Characteristic.PositionState.STOPPED);
    }
};

// Set the target position of the accessory
// position: if device supports brightness, sets brightness to equal position; otherwise turns device on if position > 0, or off otherwise
// callback: invokes callback(error), error is undefined if no error occurred
// context: if equal to IndigoAccessory.REFRESH_CONTEXT, will not call the Indigo RESTful API to update the device, and will not update CurrentPosition
//          otherwise, calls the Indigo RESTful API and also updates CurrentPosition to match position after a one second delay
IndigoPositionAccessory.prototype.setTargetPosition = function(position, callback, context) {
    this.log("%s: setTargetPosition(%s)", this.name, position);
    if (context == IndigoAccessory.REFRESH_CONTEXT) {
        callback();
    } else if (this.typeSupportsOnOff || this.typeSupportsDim) {
        if (this.typeSupportsDim) {
            this.updateStatus({ brightness: position }, callback);
        } else {
            this.updateStatus({ isOn: (position > 0) ? 1 : 0 }, callback);
        }
        // Update current state to match target state
        setTimeout(
            function() {
                this.service
                    .getCharacteristic(Characteristic.CurrentPosition)
                    .setValue(position, undefined, IndigoAccessory.REFRESH_CONTEXT);
            }.bind(this),
        1000);
    } else {
        callback("Accessory does not support on/off or dim");
    }
};

// Update HomeKit state to match state of Indigo's isOn property
// Does nothing if device supports brightness
// isOn: new value of isOn property
IndigoPositionAccessory.prototype.update_isOn = function(isOn) {
    if (! this.typeSupportsDim) {
        var position = (isOn) ? 100: 0;
        this.service
            .getCharacteristic(Characteristic.CurrentPosition)
            .setValue(position, undefined, IndigoAccessory.REFRESH_CONTEXT);
        this.service
            .getCharacteristic(Characteristic.TargetPosition)
            .setValue(position, undefined, IndigoAccessory.REFRESH_CONTEXT);
    }
};

// Update HomeKit state to match state of Indigo's brightness property
// brightness: new value of brightness property
IndigoPositionAccessory.prototype.update_brightness = function(brightness) {
    this.service
        .getCharacteristic(Characteristic.CurrentPosition)
        .setValue(brightness, undefined, IndigoAccessory.REFRESH_CONTEXT);
    this.service
        .getCharacteristic(Characteristic.TargetPosition)
        .setValue(brightness, undefined, IndigoAccessory.REFRESH_CONTEXT);
};


//
// Indigo Door Accessory
//
// platform: the HomeKit platform
// deviceURL: the path of the RESTful call for this device, relative to the base URL in the configuration, starting with a /
// json: the json that describes this device
//
function IndigoDoorAccessory(platform, deviceURL, json) {
    IndigoPositionAccessory.call(this, platform, deviceURL, json, new Service.Door(this.name));
}


//
// Indigo Window Accessory
//
// platform: the HomeKit platform
// deviceURL: the path of the RESTful call for this device, relative to the base URL in the configuration, starting with a /
// json: the json that describes this device
//
function IndigoWindowAccessory(platform, deviceURL, json) {
    IndigoPositionAccessory.call(this, platform, deviceURL, json, new Service.Window(this.name));
}


//
// Indigo Window Covering Accessory
//
// platform: the HomeKit platform
// deviceURL: the path of the RESTful call for this device, relative to the base URL in the configuration, starting with a /
// json: the json that describes this device
//
function IndigoWindowCoveringAccessory(platform, deviceURL, json) {
    IndigoPositionAccessory.call(this, platform, deviceURL, json, new Service.WindowCovering(this.name));
}


//
// Indigo Garage Door Accessory
//
// platform: the HomeKit platform
// deviceURL: the path of the RESTful call for this device, relative to the base URL in the configuration, starting with a /
// json: the json that describes this device
//
function IndigoGarageDoorAccessory(platform, deviceURL, json) {
    IndigoAccessory.call(this, platform, deviceURL, json);

    var s = this.addService(new Service.GarageDoorOpener(this.name));
    s.getCharacteristic(Characteristic.CurrentDoorState)
        .on('get', this.getCurrentDoorState.bind(this));

    s.getCharacteristic(Characteristic.TargetDoorState)
        .on('get', this.getTargetDoorState.bind(this))
        .on('set', this.setTargetDoorState.bind(this));

    s.getCharacteristic(Characteristic.ObstructionDetected)
        .on('get', this.getObstructionDetected.bind(this));
}

// Get the current door state of the accessory
// callback: invokes callback(error, doorState)
//           error: error message or undefined if no error
//           doorState: Characteristic.CurrentDoorState.OPEN (device on) or Characteristic.CurrentDoorState.CLOSED (device off)
IndigoGarageDoorAccessory.prototype.getCurrentDoorState = function(callback) {
    if (this.typeSupportsOnOff) {
        this.getStatus(
            function(error) {
                if (error) {
                    callback(error);
                } else {
                    var doorState = (this.isOn) ? Characteristic.CurrentDoorState.OPEN : Characteristic.CurrentDoorState.CLOSED;
                    this.log("%s: getPosition() => %s", this.name, doorState);
                    callback(undefined, doorState);
                }
            }.bind(this)
        );
    }
};

// Get the target door state of the accessory
// callback: invokes callback(error, doorState)
//           error: error message or undefined if no error
//           doorState: Characteristic.TargetDoorState.OPEN (device on) or Characteristic.TargetDoorState.CLOSED (device off)
IndigoGarageDoorAccessory.prototype.getTargetDoorState = function(callback) {
    if (this.typeSupportsOnOff) {
        this.getStatus(
            function(error) {
                if (error) {
                    callback(error);
                } else {
                    var doorState = (this.isOn) ? Characteristic.TargetDoorState.OPEN : Characteristic.TargetDoorState.CLOSED;
                    this.log("%s: getPosition() => %s", this.name, doorState);
                    callback(undefined, doorState);
                }
            }.bind(this)
        );
    }
};

// Set the target door state of the accessory
// lockState: Characteristic.TargetDoorState.OPEN (device on) or Characteristic.TargetDoorState.CLOSED (device off)
// callback: invokes callback(error), error is undefined if no error occurred
// context: if equal to IndigoAccessory.REFRESH_CONTEXT, will not call the Indigo RESTful API to update the device, and will not update CurrentDoorState
//          otherwise, calls the Indigo RESTful API and also updates CurrentDoorState to match after a one second delay
IndigoGarageDoorAccessory.prototype.setTargetDoorState = function(doorState, callback, context) {
    this.log("%s: setTargetPosition(%s)", this.name, doorState);
    if (context == IndigoAccessory.REFRESH_CONTEXT) {
        callback();
    } else if (this.typeSupportsOnOff) {
        this.updateStatus({ isOn: (doorState == Characteristic.TargetDoorState.OPEN) ? 1 : 0 }, callback);
        // Update current state to match target state
        setTimeout(
            function() {
                this.getService(Service.GarageDoorOpener)
                    .getCharacteristic(Characteristic.CurrentDoorState)
                    .setValue((doorState == Characteristic.TargetDoorState.OPEN) ?
                                Characteristic.CurrentDoorState.OPEN : Characteristic.CurrentDoorState.CLOSED,
                                undefined, IndigoAccessory.REFRESH_CONTEXT);
            }.bind(this),
        1000);
    } else {
        callback("Accessory does not support on/off");
    }
};

// Get the obstruction detected state of the accessory
// callback: invokes callback(error, obstructionDetected)
//           error: error message or undefined if no error
//           obstructionDetected: always false
IndigoGarageDoorAccessory.prototype.getObstructionDetected = function(callback) {
    if (this.typeSupportsOnOff) {
        this.log("%s: getObstructionDetected() => %s", this.name, false);
        callback(undefined, false);
    }
};

// Update HomeKit state to match state of Indigo's isOn property
// isOn: new value of isOn property
IndigoGarageDoorAccessory.prototype.update_isOn = function(isOn) {
    var doorState = (isOn) ? Characteristic.CurrentDoorState.OPEN : Characteristic.CurrentDoorState.CLOSED;
    this.getService(Service.GarageDoorOpener)
        .getCharacteristic(Characteristic.CurrentDoorState)
        .setValue(doorState, undefined, IndigoAccessory.REFRESH_CONTEXT);

    doorState = (isOn) ? Characteristic.TargetDoorState.OPEN : Characteristic.TargetDoorState.CLOSED;
    this.getService(Service.GarageDoorOpener)
        .getCharacteristic(Characteristic.TargetDoorState)
        .setValue(doorState, undefined, IndigoAccessory.REFRESH_CONTEXT);
};


//
// Indigo Light Accessory
//
// platform: the HomeKit platform
// deviceURL: the path of the RESTful call for this device, relative to the base URL in the configuration, starting with a /
// json: the json that describes this device
//
function IndigoLightAccessory(platform, deviceURL, json) {
    IndigoAccessory.call(this, platform, deviceURL, json);

    var s = this.addService(new Service.Lightbulb(this.name));
    s.getCharacteristic(Characteristic.On)
        .on('get', this.getOnState.bind(this))
        .on('set', this.setOnState.bind(this));

    if (this.typeSupportsDim) {
        s.getCharacteristic(Characteristic.Brightness)
            .on('get', this.getBrightness.bind(this))
            .on('set', this.setBrightness.bind(this));
    }
}

// Get the brightness of the accessory
// callback: invokes callback(error, position)
//           error: error message or undefined if no error
//           brightness: if device supports brightness, will return the brightness value
IndigoLightAccessory.prototype.getBrightness = function(callback) {
    if (this.typeSupportsDim) {
        this.query("brightness", callback);
    } else {
        callback("Accessory does not support brightness");
    }
};

// Set the current brightness of the accessory
// brightness: the brightness, from 0 (off) to 100 (full on)
// callback: invokes callback(error), error is undefined if no error occurred
// context: if equal to IndigoAccessory.REFRESH_CONTEXT, will not call the Indigo RESTful API to update the device, otherwise will
IndigoLightAccessory.prototype.setBrightness = function(brightness, callback, context) {
    this.log("%s: setBrightness(%d)", this.name, brightness);
    if (context == IndigoAccessory.REFRESH_CONTEXT) {
        callback();
    } else if (this.typeSupportsDim && brightness >= 0 && brightness <= 100) {
        this.updateStatus({brightness: brightness}, callback);
    } else {
        callback("Accessory does not support brightness");
    }
};

// Update HomeKit state to match state of Indigo's isOn property
// isOn: new value of isOn property
IndigoLightAccessory.prototype.update_isOn = function(isOn) {
    var onState = (isOn) ? true : false;
    this.getService(Service.Lightbulb)
        .getCharacteristic(Characteristic.On)
        .setValue(onState, undefined, IndigoAccessory.REFRESH_CONTEXT);
};

// Update HomeKit state to match state of Indigo's brightness property
// brightness: new value of brightness property
IndigoLightAccessory.prototype.update_brightness = function(brightness) {
    this.getService(Service.Lightbulb)
        .getCharacteristic(Characteristic.Brightness)
        .setValue(brightness, undefined, IndigoAccessory.REFRESH_CONTEXT);
};


//
// Indigo Fan Accessory
//

function IndigoFanAccessory(platform, deviceURL, json) {
    IndigoAccessory.call(this, platform, deviceURL, json);

    var s = this.addService(new Service.Fan(this.name));
    s.getCharacteristic(Characteristic.On)
        .on('get', this.getOnState.bind(this))
        .on('set', this.setOnState.bind(this));

    s.getCharacteristic(Characteristic.RotationSpeed)
        .on('get', this.getRotationSpeed.bind(this))
        .on('set', this.setRotationSpeed.bind(this));
}

IndigoFanAccessory.prototype.getRotationSpeed = function(callback) {
    if (this.typeSupportsSpeedControl) {
        this.query("speedIndex",
            function(error, speedIndex) {
                if (error) {
                    callback(error);
                } else {
                    callback(undefined, (speedIndex / 3.0) * 100.0);
                }
            }
        );
    }
    else {
        callback("Accessory does not support rotation speed");
    }
};

IndigoFanAccessory.prototype.setRotationSpeed = function(rotationSpeed, callback) {
    if (this.typeSupportsSpeedControl && rotationSpeed >= 0.0 && rotationSpeed <= 100.0) {
        var speedIndex = 0;
        if (rotationSpeed > 66.6) {
            speedIndex = 3;
        } else if (rotationSpeed > 33.3) {
            speedIndex = 2;
        } else if (rotationSpeed > 0) {
            speedIndex = 1;
        }
        this.updateStatus({ speedIndex: speedIndex }, callback);
    }
    else {
        callback("Accessory does not support rotation speed");
    }
};


//
// Indigo Thermostat Accessory
//

function IndigoThermostatAccessory(platform, deviceURL, json, thermostatsInCelsius) {
    IndigoAccessory.call(this, platform, deviceURL, json);

    this.thermostatsInCelsius = thermostatsInCelsius;

    this.temperatureDisplayUnits = (thermostatsInCelsius) ?
        Characteristic.TemperatureDisplayUnits.CELSIUS :
        Characteristic.TemperatureDisplayUnits.FAHRENHEIT;

    var s = this.addService(new Service.Thermostat(this.name));
    s.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
        .on('get', this.getCurrentHeatingCooling.bind(this));

    s.getCharacteristic(Characteristic.TargetHeatingCoolingState)
        .on('get', this.getTargetHeatingCooling.bind(this))
        .on('set', this.setTargetHeatingCooling.bind(this));

    s.getCharacteristic(Characteristic.CurrentTemperature)
        .on('get', this.getCurrentTemperature.bind(this));

    s.getCharacteristic(Characteristic.TargetTemperature)
        .on('get', this.getTargetTemperature.bind(this))
        .on('set', this.setTargetTemperature.bind(this));

    s.getCharacteristic(Characteristic.TemperatureDisplayUnits)
        .on('get', this.getTemperatureDisplayUnits.bind(this))
        .on('set', this.setTemperatureDisplayUnits.bind(this));

    s.getCharacteristic(Characteristic.CoolingThresholdTemperature)
        .on('get', this.getCoolingThresholdTemperature.bind(this))
        .on('set', this.setCoolingThresholdTemperature.bind(this));

    s.getCharacteristic(Characteristic.HeatingThresholdTemperature)
        .on('get', this.getHeatingThresholdTemperature.bind(this))
        .on('set', this.setHeatingThresholdTemperature.bind(this));

    if (this.displayHumidityInRemoteUI) {
        s.getCharacteristic(Characteristic.CurrentRelativeHumidity)
            .on('get', this.getCurrentRelativeHumidity.bind(this));
    }
}

IndigoThermostatAccessory.prototype.getCurrentHeatingCooling = function(callback) {
    this.getStatus(
        function(error) {
            if (error) {
                callback(error);
            } else {
                var mode = Characteristic.CurrentHeatingCoolingState.OFF;
                if (this.hvacHeaterIsOn) {
                    mode = Characteristic.CurrentHeatingCoolingState.HEAT;
                } else if (this.hvacCoolerIsOn) {
                    mode = Characteristic.CurrentHeatingCoolingState.COOL;
                }
                this.log("%s: getCurrentHeatingCooling() => %s", this.name, mode);
                callback(undefined, mode);
            }
        }.bind(this)
    );
};

IndigoThermostatAccessory.prototype.getTargetHeatingCooling = function(callback) {
    this.getStatus(
        function(error) {
            if (error) {
                callback(error);
            } else {
                var mode = Characteristic.TargetHeatingCoolingState.OFF;
                if (this.hvacOperationModeIsHeat || this.hvacOperationModeIsProgramHeat) {
                    mode = Characteristic.TargetHeatingCoolingState.HEAT;
                } else if (this.hvacOperationModeIsCool || this.hvacOperationModeIsProgramCool) {
                    mode = Characteristic.TargetHeatingCoolingState.COOL;
                } else if (this.hvacOperationModeIsAuto || this.hvacOperationModeIsProgramAuto) {
                    mode = Characteristic.TargetHeatingCoolingState.AUTO;
                }
                this.log("%s: getTargetHeatingCooling() => %s", this.name, mode);
                callback(undefined, mode);
            }
        }.bind(this)
    );
};

IndigoThermostatAccessory.prototype.setTargetHeatingCooling = function(mode, callback) {
    this.log("%s: setTargetHeatingCooling(%s)", this.name, mode);
    var qs;
    if (mode == Characteristic.TargetHeatingCoolingState.OFF) {
        qs = { hvacOperationModeIsOff: "true" };
    }
    else if (mode == Characteristic.TargetHeatingCoolingState.HEAT) {
        qs = { hvacOperationModeIsHeat: "true" };
    }
    else if (mode == Characteristic.TargetHeatingCoolingState.COOL) {
        qs = { hvacOperationModeIsCool: "true" };
    }
    else if (mode == Characteristic.TargetHeatingCoolingState.AUTO) {
        qs = { hvacOperationModeIsAuto: "true" };
    }

    if (qs) {
        this.updateStatus(qs, callback);
    } else {
        callback("Unknown target heating/cooling state");
    }
};

// Note: HomeKit wants all temperature values in celsius, so convert if needed
IndigoThermostatAccessory.prototype.celsiusToIndigoTemp = function(temperature) {
    if (this.thermostatsInCelsius) {
        return (temperature);
    } else {
        return (Math.round(((temperature * 9.0 / 5.0) + 32.0) * 10.0) / 10.0);
    }
}

IndigoThermostatAccessory.prototype.indigoTempToCelsius = function(temperature) {
    if (this.thermostatsInCelsius) {
        return (temperature);
    } else {
        return (Math.round(((temperature - 32.0) * 5.0 / 9.0) * 10.0) / 10.0);
    }
}

IndigoThermostatAccessory.prototype.getTemperatureValue = function(key, callback) {
    this.query(key,
        function(error, temperature) {
            if (error) {
                callback(error);
            } else {
                var t = this.indigoTempToCelsius(temperature);
                this.log("%s: getTemperatureValue(%s) => %s", this.name, key, t);
                callback(undefined, t);
            }
        }.bind(this)
    );
};

IndigoThermostatAccessory.prototype.setTemperatureValue = function(key, temperature, callback) {
    this.log("%s: setTemperatureValue(%s, %s)", this.name, key, temperature);
    var qs = { };
    qs[key] = this.celsiusToIndigoTemp(temperature);
    this.updateStatus(qs, callback);
};

IndigoThermostatAccessory.prototype.getCurrentTemperature = function(callback) {
    this.getTemperatureValue("inputTemperatureVals", callback);
};

IndigoThermostatAccessory.prototype.getTargetTemperature = function(callback) {
    this.getStatus(
        function(error) {
            if (error) {
                callback(error);
            } else {
                var temperature;
                if (this.hvacOperationModeIsHeat || this.hvacOperationModeIsProgramHeat) {
                    temperature = this.setpointHeat;
                }
                else if (this.hvacOperationModeIsCool || this.hvacOperationModeIsProgramCool) {
                    temperature = this.setpointCool;
                }
                else {
                    temperature = (this.setpointHeat + this.setpointCool) / 2.0;
                }
                var t = this.indigoTempToCelsius(temperature);
                this.log("%s: getTargetTemperature() => %s", this.name, t);
                callback(undefined, t);
            }
        }.bind(this)
    );
};

IndigoThermostatAccessory.prototype.setTargetTemperature = function(temperature, callback) {
    this.log("%s: setTargetTemperature(%s)", this.name, temperature);
    var t = this.celsiusToIndigoTemp(temperature);
    this.getStatus(
        function(error) {
            if (error) {
                callback(error);
            } else {
                var qs;
                if (this.hvacOperationModeIsHeat) {
                    qs = { setpointHeat: t };
                }
                else if (this.hvacOperationModeIsCool) {
                    qs = { setpointCool: t };
                }
                else {
                    var adjust = (this.thermostatsInCelsius) ? 2 : 5;
                    qs = { setpointCool: t + adjust, setpointHeat: t - adjust };
                }
                this.updateStatus(qs, callback);
            }
        }.bind(this)
    );
};

IndigoThermostatAccessory.prototype.getTemperatureDisplayUnits = function(callback) {
    this.log("%s: getTemperatureDisplayUnits() => %s", this.name, this.temperatureDisplayUnits);
    callback(undefined, this.temperatureDisplayUnits);
};

IndigoThermostatAccessory.prototype.setTemperatureDisplayUnits = function(units, callback) {
    this.log("%s: setTemperatureDisplayUnits(%s)", this.name, units);
    this.temperatureDisplayUnits = units;
    callback();
};

IndigoThermostatAccessory.prototype.getCoolingThresholdTemperature = function(callback) {
    this.getTemperatureValue("setpointCool", callback);
};

IndigoThermostatAccessory.prototype.setCoolingThresholdTemperature = function(temperature, callback) {
    this.setTemperatureValue("setpointCool", temperature, callback);
};

IndigoThermostatAccessory.prototype.getHeatingThresholdTemperature = function(callback) {
    this.getTemperatureValue("setpointHeat", callback);
};

IndigoThermostatAccessory.prototype.setHeatingThresholdTemperature = function(temperature, callback) {
    this.setTemperatureValue("setpointHeat", temperature, callback);
};

IndigoThermostatAccessory.prototype.getCurrentRelativeHumidity = function(callback) {
    if (this.displayHumidityInRemoteUI) {
        this.query("inputHumidityVals", callback);
    } else {
        callback("Accessory does not support current relative humidity");
    }
};


//
// Indigo Action Accessory
//

function IndigoActionAccessory(platform, deviceURL, json) {
    IndigoAccessory.call(this, platform, deviceURL, json);

    this.addService(new Service.Switch(this.name))
        .getCharacteristic(Characteristic.On)
        .on('get', this.getActionState.bind(this))
        .on('set', this.executeAction.bind(this));
}

// Actions always say they are off
IndigoActionAccessory.prototype.getActionState = function(callback) {
    this.log("%s: getActionState() => %s", this.name, false);
    callback(undefined, false);
};

// Execute the action and turn the switch back off
IndigoActionAccessory.prototype.executeAction = function(value, callback, context) {
    this.log("%s: executeAction(%s)", this.name, value);
    if (value && context !== IndigoAccessory.REFRESH_CONTEXT) {
        this.platform.indigoRequest(this.deviceURL, "EXECUTE", null,
            function(error, response, body) {
                if (error) {
                    this.log("Error executing action group: %s", error);
                }
            }.bind(this)
        );

        // Turn the switch back off
        setTimeout(
            function() {
                this.getService(Service.Switch)
                    .getCharacteristic(Characteristic.On)
                    .setValue(false, undefined, IndigoAccessory.REFRESH_CONTEXT);
            }.bind(this),
        1000);
    }

    if (callback) {
        callback();
    }
};
