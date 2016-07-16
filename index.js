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
        "accessoryNamePrefix": ""
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

Note that if you specify both "includeIds" and "excludeIds", then only the IDs that are in
"includeIds" and missing from "excludeIds" will be mapped to HomeKit devices.  Typically,
you would only specify one or the other, not both of these lists.  If you just want to
expose everything, then omit both of these keys from your configuration.

Also note that any Indigo devices or actions that have Remote Display unchecked in Indigo
will NOT be exposed to HomeKit, because Indigo excludes those devices from its RESTful API.
*/

var request = require("request");
var async = require("async");
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


function IndigoPlatform(log, config) {
    this.log = log;

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
}

// Invokes callback(accessories[])
IndigoPlatform.prototype.accessories = function(callback) {
    this.foundAccessories = [];

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

// Invokes callback(error), error is undefined if no error occurred
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

// Invokes callback(error), error is always undefined as we want to ignore errors
IndigoPlatform.prototype.addAccessory = function(item, callback) {
    this.indigoRequestJSON(item.restURL, "GET", null,
        function(error, json) {
            if (error) {
                this.log("Ignoring accessory %s due to error", item.restURL);
                callback();
            }
            else {
                if (json.restParent == "actions") {
                    json.type = "Action";
                }
                this.log("Discovered %s (ID %s): %s", json.type, json.id, json.name);
                if (this.includeItemId(json.id)) {
                    var accessory = this.createAccessoryFromJSON(item.restURL, json);
                    if (accessory) {
                        this.foundAccessories.push(accessory);
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
IndigoPlatform.prototype.includeItemId = function(id) {
    if (this.includeIds && (this.includeIds.indexOf(String(id)) < 0)) {
        return false;
    }

    if (this.excludeIds && (this.excludeIds.indexOf(String(id)) >= 0)) {
        return false;
    }

    return true;
};

// Invokes callback(error, response, body) with result of HTTP request
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

    this.log("Indigo request: %s", this.baseURL + path);
    request(options, callback);
};

// Invokes callback(error, json) with JSON object returned by HTTP request
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


//
// Generic Indigo Accessory
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

IndigoAccessory.prototype.getServices = function() {
    return this.services;
};

// Updates object fields with values from json
IndigoAccessory.prototype.updateFromJSON = function(json) {
    for (var prop in json) {
        if (json.hasOwnProperty(prop)) {
            this[prop] = json[prop];
        }
    }

    if (json.name !== undefined) {
        this.name = this.platform.accessoryNamePrefix + String(json.name);
    }
};

// Invokes callback(error), error is undefined if no error occurred
IndigoAccessory.prototype.getStatus = function(callback) {
    this.platform.indigoRequestJSON(this.deviceURL, "GET", null,
        function(error, json) {
            if (error) {
                callback(error);
            } else {
                this.updateFromJSON(json);
                callback();
            }
        }.bind(this)
    );
};

// Invokes callback(error), error is undefined if no error occurred
IndigoAccessory.prototype.updateStatus = function(qs, callback) {
    this.log("updateStatus of %s: %s", this.name, JSON.stringify(qs));
    this.platform.indigoRequest(this.deviceURL, "PUT", qs,
        function(error, response, body) {
            if (error) {
                callback(error);
            } else {
                callback();
            }
        }.bind(this)
    );
};

// Invokes callback(error, value), error is undefined if no error occurred
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

IndigoAccessory.prototype.setOnState = function(onState, callback) {
    this.log("%s: setOnState(%s)", this.name, onState);
    if (this.typeSupportsOnOff) {
        this.updateStatus({ isOn: (onState) ? 1 : 0 }, callback);
    } else {
        callback("Accessory does not support on/off");
    }
};


//
// Indigo Switch Accessory
//

function IndigoSwitchAccessory(platform, deviceURL, json) {
    IndigoAccessory.call(this, platform, deviceURL, json);

    var s = this.addService(new Service.Switch(this.name));
    s.getCharacteristic(Characteristic.On)
        .on('get', this.getOnState.bind(this))
        .on('set', this.setOnState.bind(this));
}


//
// Indigo Lock Accessory
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

IndigoLockAccessory.prototype.setLockTargetState = function(lockState, callback) {
    this.log("%s: setLockTargetState(%s)", this.name, lockState);
    if (this.typeSupportsOnOff) {
        this.updateStatus({ isOn: (lockState == Characteristic.LockTargetState.SECURED) ? 1 : 0 }, callback);
        // Update current state to match target state
        setTimeout(
            function() {
                this.getService(Service.LockMechanism)
                    .getCharacteristic(Characteristic.LockCurrentState)
                    .setValue((lockState == Characteristic.LockTargetState.SECURED) ?
                                Characteristic.LockCurrentState.SECURED : Characteristic.LockCurrentState.UNSECURED,
                                undefined, 'fromSetValue');
            }.bind(this),
        1000);
    } else {
        callback("Accessory does not support on/off");
    }
};


//
// Indigo Position Accessory (Door, Window, or Window Covering)
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

IndigoPositionAccessory.prototype.getPosition = function(callback) {
    if (this.typeSupportsOnOff  || this.typeSupportsDim) {
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

IndigoPositionAccessory.prototype.getPositionState = function(callback) {
    if (this.typeSupportsOnOff) {
        this.log("%s: getPositionState() => %s", this.name, Characteristic.PositionState.STOPPED);
        callback(undefined, Characteristic.PositionState.STOPPED);
    }
};


IndigoPositionAccessory.prototype.setTargetPosition = function(position, callback) {
    this.log("%s: setTargetPosition(%s)", this.name, position);
    if (this.typeSupportsOnOff || this.typeSupportsDim) {
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
                    .setValue(position, undefined, 'fromSetValue');
            }.bind(this),
        1000);
    } else {
        callback("Accessory does not support on/off or dim");
    }
};


//
// Indigo Door Accessory
//

function IndigoDoorAccessory(platform, deviceURL, json) {
    IndigoPositionAccessory.call(this, platform, deviceURL, json, new Service.Door(this.name));
}


//
// Indigo Window Accessory
//

function IndigoWindowAccessory(platform, deviceURL, json) {
    IndigoPositionAccessory.call(this, platform, deviceURL, json, new Service.Window(this.name));
}


//
// Indigo Window Covering Accessory
//

function IndigoWindowCoveringAccessory(platform, deviceURL, json) {
    IndigoPositionAccessory.call(this, platform, deviceURL, json, new Service.WindowCovering(this.name));
}


//
// Indigo Garage Door Accessory
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

IndigoGarageDoorAccessory.prototype.setTargetDoorState = function(doorState, callback) {
    this.log("%s: setTargetPosition(%s)", this.name, doorState);
    if (this.typeSupportsOnOff) {
        this.updateStatus({ isOn: (doorState == Characteristic.TargetDoorState.OPEN) ? 1 : 0 }, callback);
        // Update current state to match target state
        setTimeout(
            function() {
                this.getService(Service.GarageDoorOpener)
                    .getCharacteristic(Characteristic.CurrentDoorState)
                    .setValue((doorState == Characteristic.TargetDoorState.OPEN) ?
                                Characteristic.CurrentDoorState.OPEN : Characteristic.CurrentDoorState.CLOSED,
                                undefined, 'fromSetValue');
            }.bind(this),
        1000);
    } else {
        callback("Accessory does not support on/off");
    }
};

IndigoGarageDoorAccessory.prototype.getObstructionDetected = function(callback) {
    if (this.typeSupportsOnOff) {
        this.log("%s: getObstructionDetected() => %s", this.name, false);
        callback(undefined, false);
    }
};


//
// Indigo Light Accessory
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

IndigoLightAccessory.prototype.getBrightness = function(callback) {
    if (this.typeSupportsDim) {
        this.query("brightness", callback);
    } else {
        callback("Accessory does not support brightness");
    }
};

IndigoLightAccessory.prototype.setBrightness = function(brightness, callback) {
    if (this.typeSupportsDim && brightness >= 0 && brightness <= 100) {
        this.updateStatus({ brightness: brightness }, callback);
    } else {
        callback("Accessory does not support brightness");
    }
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
    if (value && context !== 'fromSetValue') {
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
                    .setValue(false, undefined, 'fromSetValue');
            }.bind(this),
        1000);
    }

    if (callback) {
        callback();
    }
};
