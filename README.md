# homebridge-indigo
[Homebridge](https://github.com/nfarina/homebridge) platform plugin for the [Indigo home automation server](http://indigodomotics.com/)

Supports the following Indigo device types:
* Lights and Switches (dimmable and non-dimmable, all represented as HomeKit lights)
* Outlets (represented as HomeKit lights)
* Thermostats (represented as HomeKit thermostats)
* Ceiling Fans (represented as HomeKit fans)
* Actions (optional, represented as HomeKit switches)

# Installation

1. Install homebridge using: npm install -g homebridge
2. Install this plugin using: npm install -g homebridge-indigo
3. Update your configuration file. See sampleconfig.json in this repository for a sample. 

# Configuration

Configuration sample:

 ```
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
```

Fields: 
* "platform": Must always be "Indigo" (required)
* "name": Can be anything (required)
* "protocol": "http" or "https" (optional, defaults to "http" if not specified)
* "host": Hostname or IP Address of your Indigo web server (required)
* "port": Port number of your Indigo web server (optional, defaults to "8176" if not specified)
* "path": The path to the root of your Indigo web server (optional, defaults to "" if not specified, only needed if you have a proxy in front of your Indigo web server)
* "username": Username to log into Indigo web server, if applicable (optional)
* "password": Password to log into Indigo web server, if applicable (optional)
* "includeActions": If true, creates HomeKit switches for your actions (optional, defaults to false)
* "includeIds": Array of Indigo IDs to include (optional - if provided, only these Indigo IDs will map to HomeKit devices)
* "excludeIds": Array of Indigo IDs to exclude (optional - if provided, these Indigo IDs will not be mapped to HomeKit devices)
* "accessoryNamePrefix": Prefix all accessory names with this string (optional, useful for testing)

Note that if you specify both "includeIds" and "excludeIds", then only the IDs that are in
"includeIds" and missing from "excludeIds" will be mapped to HomeKit devices.  Typically,
you would only specify one or the other, not both of these lists.  If you just want to
expose everything, then omit both of these keys from your configuration.

Also note that any Indigo devices or actions that have Remote Display unchecked in Indigo
will NOT be exposed to HomeKit, because Indigo excludes those devices from its RESTful API.
