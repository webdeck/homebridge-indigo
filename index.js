/*
Indigo platform shim for HomeBridge
Written by Mike Riccio (https://github.com/webdeck/homebridge-indigo)
See http://www.indigodomo.com/ for more info on Indigo

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
        "excludeIds:": [ "98765", "43210" ],
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

    var path = "";
    if (config.path) {
        path = config.path;
        // Strip out trailing slash, since device URLs all start with a slash
        if (path.length > 0 && path.charAt(path.length -1) == '/') {
            path = path.substr(0, path.length - 1);
        }
    }

    this.baseURL = protocol + "://" + config.host + ":" + port + path;
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

    if (config.accessoryNamePrefix) {
        this.accessoryNamePrefix = config.accessoryNamePrefix;
    } else {
        this.accessoryNamePrefix = "";
    }
}

// Invokes callback(accessories[])
IndigoPlatform.prototype.accessories = function(callback) {
    this.foundAccessories = [];
    var that = this;

    var requestURLs = [ "/devices.json/" ];
    if (this.includeActions) {
        requestURLs.push("/actions.json/");
    }

    async.eachSeries(requestURLs,
        function(requestURL, asyncCallback) {
            that.discoverAccessories(requestURL, asyncCallback);
        },
        function (asyncError) {
            if (asyncError) {
                that.log(asyncError);
            }

            that.log("Created %s accessories", that.foundAccessories.length);
            callback(that.foundAccessories.sort(
                function (a, b) {
                    return (a.name > b.name) - (a.name < b.name);
                }
            ));
        }
    );
};

// Invokes callback(error), error is undefined if no error occurred
IndigoPlatform.prototype.discoverAccessories = function(requestURL, callback) {
    this.log("Discovering Indigo accessories from %s", requestURL);

    this.indigoRequest(requestURL, "GET", null,
        function(error, response, body) {
            if (error) {
                var msg = "Error discovering Indigo accessories from " + requestURL + ": " + error;
                this.log(msg);
                callback(msg);
            }
            else {
                // Indigo has a bug that if the first item has remote display disabled,
                // the returned JSON array has an extra comma at the beginning
                var firstComma = body.indexOf(",");
                if (firstComma > 0 && firstComma < 5) {
                    body = body.substr(0, firstComma) + body.substr(firstComma + 1);
                }

                var json;
                try {
                    json = JSON.parse(body);
                } catch (e) {
                    var msg2 = "Error parsing Indigo response: Exception: " + e + "\nResponse: " + body;
                    this.log(msg2);
                    callback(msg2);
                    return;
                }

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
        }.bind(this)
    );
};

// Invokes callback(error), error is undefined if no error occurred
IndigoPlatform.prototype.addAccessory = function(item, callback) {
    this.log("Discovering accessory from %s", item.restURL);

    this.indigoRequestJSON(item.restURL, "GET", null,
        function(error, json) {
            if (error) {
                callback(error);
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
    var options = {
        url: this.baseURL + path,
        method: method,
        followRedirect: false
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
IndigoPlatform.prototype.indigoRequestJSON = function(path, method, qs, callback) {
    this.indigoRequest(path, method, qs,
        function(error, response, body) {
            if (error) {
                var msg = "Error for Indigo request " + path + ": " + error;
                this.log(msg);
                callback(msg);
            }
            else {
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
                callback(null, json);
            }
        }.bind(this)
    );
};

// Returns subclass of IndigoAccessory based on json, or null if unsupported type
IndigoPlatform.prototype.createAccessoryFromJSON = function(deviceURL, json) {
    if (json.restParent == "actions") {
        return new IndigoActionAccessory(this, deviceURL, json);
    } else if (json.typeSupportsHVAC) {
        return new IndigoThermostatAccessory(this, deviceURL, json);
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

    this.getService(Service.AccessoryInformation)
        .setCharacteristic(Characteristic.Manufacturer, "Indigo")
        .setCharacteristic(Characteristic.SerialNumber, String(this.id));

    if (this.type) {
        this.getService(Service.AccessoryInformation)
            .setCharacteristic(Characteristic.Model, this.type);
    }

    if (this.versByte) {
        this.getService(Service.AccessoryInformation)
            .setCharacteristic(Characteristic.FirmwareRevision, this.versByte);
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

    if (json.name) {
        this.name = this.platform.accessoryNamePrefix + json.name;
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

// Invokes callback(error, value), error is null if no error occurred
IndigoAccessory.prototype.query = function(key, callback) {
    this.getStatus(
        function(error) {
            if (error) {
                callback(error);
            } else {
                this.log("%s: query(%s) => %s", this.name, key, this[key]);
                callback(null, this[key]);
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
                    var onState = (this.isOn) ? 1 : 0;
                    this.log("%s: getOnState() => %s", this.name, onState);
                    callback(null, onState);
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
// Indigo Light Accessory
//

function IndigoLightAccessory(platform, deviceURL, json) {
    IndigoAccessory.call(this, platform, deviceURL, json);

    this.addService(Service.Lightbulb)
        .getCharacteristic(Characteristic.On)
        .on('get', this.getOnState.bind(this))
        .on('set', this.setOnState.bind(this));

    if (this.typeSupportsDim) {
        this.getService(Service.Lightbulb)
            .getCharacteristic(Characteristic.Brightness)
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

    this.addService(Service.Fan)
        .getCharacteristic(Characteristic.On)
        .on('get', this.getOnState.bind(this))
        .on('set', this.setOnState.bind(this));

    this.getService(Service.Fan)
        .getCharacteristic(Characteristic.RotationSpeed)
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
                    callback(null, (speedIndex / 3.0) * 100.0);
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

function IndigoThermostatAccessory(platform, deviceURL, json) {
    IndigoAccessory.call(this, platform, deviceURL, json);

    this.temperatureDisplayUnits = Characteristic.TemperatureDisplayUnits.FAHRENHEIT;

    this.addService(Service.Thermostat)
        .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
        .on('get', this.getCurrentHeatingCooling.bind(this));

    this.getService(Service.Thermostat)
        .getCharacteristic(Characteristic.TargetHeatingCoolingState)
        .on('get', this.getTargetHeatingCooling.bind(this))
        .on('set', this.setTargetHeatingCooling.bind(this));

    this.getService(Service.Thermostat)
        .getCharacteristic(Characteristic.CurrentTemperature)
        .on('get', this.getCurrentTemperature.bind(this));

    this.getService(Service.Thermostat)
        .getCharacteristic(Characteristic.TargetTemperature)
        .on('get', this.getTargetTemperature.bind(this))
        .on('set', this.setTargetTemperature.bind(this));

    this.getService(Service.Thermostat)
        .getCharacteristic(Characteristic.TemperatureDisplayUnits)
        .on('get', this.getTemperatureDisplayUnits.bind(this))
        .on('set', this.setTemperatureDisplayUnits.bind(this));

    this.getService(Service.Thermostat)
        .getCharacteristic(Characteristic.CoolingThresholdTemperature)
        .on('get', this.getCoolingThresholdTemperature.bind(this))
        .on('set', this.setCoolingThresholdTemperature.bind(this));

    this.getService(Service.Thermostat)
        .getCharacteristic(Characteristic.HeatingThresholdTemperature)
        .on('get', this.getHeatingThresholdTemperature.bind(this))
        .on('set', this.setHeatingThresholdTemperature.bind(this));

	if (this.displayHumidityInRemoteUI) {
		this.getService(Service.Thermostat)
			.getCharacteristic(Characteristic.CurrentRelativeHumidity)
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
                callback(null, mode);
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
                callback(null, mode);
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

// Note: Service.Thermostat seems to want all temperature values in celsius
IndigoThermostatAccessory.prototype.celsiusToFahrenheit = function(degreesCelsius) {
    return (Math.round(((degreesCelsius * 9.0 / 5.0) + 32.0) * 10.0) / 10.0);
}

IndigoThermostatAccessory.prototype.fahrenheitToCelsius = function(degreesFahrenheit) {
    return (Math.round(((degreesFahrenheit - 32.0) * 5.0 / 9.0) * 10.0) / 10.0);
}

IndigoThermostatAccessory.prototype.getTemperatureValue = function(key, callback) {
    this.query(key,
        function(error, temperature) {
            if (error) {
                callback(error);
            } else {
                var t = this.fahrenheitToCelsius(temperature);
                this.log("%s: getTemperatureValue(%s) => %s", this.name, key, t);
                callback(null, t);
            }
        }.bind(this)
    );
};

IndigoThermostatAccessory.prototype.setTemperatureValue = function(key, temperature, callback) {
    this.log("%s: setTemperatureValue(%s, %s)", this.name, key, temperature);
    var qs = { };
    qs[key] = this.celsiusToFahrenheit(temperature);
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
                var t = this.fahrenheitToCelsius(temperature);
                this.log("%s: getTargetTemperature() => %s", this.name, t);
                callback(null, t);
            }
        }.bind(this)
    );
};

IndigoThermostatAccessory.prototype.setTargetTemperature = function(temperature, callback) {
    this.log("%s: setTargetTemperature(%s)", this.name, temperature);
    var t = this.celsiusToFahrenheit(temperature);
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
                    qs = { setpointCool: t + 5, setpointHeat: t - 5 };
                }
                this.updateStatus(qs, callback);
            }
        }.bind(this)
    );
};

IndigoThermostatAccessory.prototype.getTemperatureDisplayUnits = function(callback) {
	this.log("%s: getTemperatureDisplayUnits() => %s", this.name, this.temperatureDisplayUnits);
    callback(null, this.temperatureDisplayUnits);
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

    this.addService(Service.Switch)
        .getCharacteristic(Characteristic.On)
        .on('get', this.getActionState.bind(this))
        .on('set', this.executeAction.bind(this));
}

// Actions always say they are off
IndigoActionAccessory.prototype.getActionState = function(callback) {
	this.log("%s: getActionState() => %s", this.name, 0);
	callback(null, 0);
};

// Execute the action and say it's off
IndigoActionAccessory.prototype.executeAction = function(value, callback) {
    this.log("%s: executeAction(%s) => %s", this.name, value, 0);
    if (value == 1) {
        this.platform.indigoRequest(this.deviceURL, "EXECUTE", null,
            function(error, response, body) {
                if (error) {
                    callback(error, 0);
                } else {
                    callback(null, 0);
                }
            }.bind(this)
        );
    }
    else {
        callback(null, 0);
    }
};
