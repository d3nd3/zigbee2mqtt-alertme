var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const fz = require('zigbee-herdsman-converters/converters/fromZigbee');
const tz = require('zigbee-herdsman-converters/converters/toZigbee');
const exposes = require('zigbee-herdsman-converters/lib/exposes');
const reporting = require('zigbee-herdsman-converters/lib/reporting');
const legacy = require('zigbee-herdsman-converters/lib/legacy');
const extend = require('zigbee-herdsman-converters/lib/extend');

const utils = require('zigbee-herdsman-converters/lib/utils');
const globalStore = require('zigbee-herdsman-converters/lib/store');
const e = exposes.presets;
const ea = exposes.access;


// const entity_1 = __importDefault(require("zigbee-herdsman/dist/controller/model/entity"));

// const unpi_1 = require("zigbee-herdsman/dist/adapter/z-stack/unpi");
// const Subsystem = unpi_1.Constants.Subsystem;
// const Type = unpi_1.Constants.Type;

//const ep = require('zigbee-herdsman/src/controller/model/endpoint');
const profileID = 0xC216;
//normal mode gives power consumption redings.
const modes = ["normal","range_test","locked","seeking","idle","dormant"];


/*
Initial Mode after pairing is Dormant Mode.
When re-inserted into plug socket, receives 1x Range Test 0xFD (rssi, lqi)
Timers are reset when power is lost.
uptimeMillisec timer in heartbeat is slightly fast/inaccurate/gains time
uptimeSec timer more reliable in power consumption report
HNF 2 == Unpair. I assume they just set HNF 1 with dormant mode, to make paired in driver.
*/
//sends powerDemand every 10 seconds
//HeartBeat every 30 seconds
//powerComption every minute
const MODE_NORMAL = 0; 
//sends rangeTest every second.
const MODE_RANGETEST = 1; 
//LockDevice, becomes unusable? Emergency?
const MODE_LOCKED = 2;
//sends rangeTest every 30 seconds. - guessing this enters pairing mode if hub disconnects?
const MODE_SEEKING = 3;
//sends rangeTest every 30 seconds. 
const MODE_IDLE = 4; 
//sends heartBeat every 30 seconds. This is the initial mode after pairing.
const MODE_DORMANT = 5; 

/*
"RECV_HEARTBEAT": {
        "lqi": 255, //always 255? doesn't work?
        "msTimer": 975136,
        "psuVoltage": 4731,
        "rssi": -44,
        "statusFlags": 31,
        "switchMask": 1,
        "switchState": 0,
        "temperature": 476
    },
    HAS_VOLTAGE = 1
    HAS_TEMPERATURE = 2
    HAS_SWITCH_STATE = 4
    HAS_LQI = 8
    HAS_RSSI = 16
*/

/*
"RANGE_TEST": {
        "lqi": 255,
        "rssi": -44
    },
*/
//possible that HomeNetworkFlag can be cleared with value 2.

const REMOTE_TRUE = 1;
const REMOTE_FALSE = 0;

const SWITCH_ON = 1;
const SWITCH_OFF = 0;
//srcEndpoint: 0
const alertmeOptions = {
    srcEndpoint: 2,
    //transactionSequenceNumber: 0,
    disableDefaultResponse: true,
    timeout: 20000
};

let ameProfEndpoint = null;

let remoteInterval = null;
const remoteModeFrequency = 60; //minutes


/*
model = entity.definition (entity==endpoint)
msg = data
publish = callback to mqtt public, same as return
options = entity.settings
meta = {device: data.device, logger, state: this.state.get(data.device.ieeeAddr)};
*/
/*
    This forms the data that everything else shows.

    How do I differentiate them, find the command?
    When packet is received, its clusterID is converted into name.
    The commandID from the packet is searched in the cluster, and its key-value is used as
    command name if exists in events.js. However teh command name is dropped for the value associated
    in events.js. That is a shame.  Means I have to either create more mappings there, or detect 
    commands by the presence of certain values in the json data of the cluster definitions.

    Clusters which have more than one command, must have unique fields to identify them.
*/
const fzLocal = {
    //==CLUSTER SWITCH==
    alertmeSwitchState_fz: {
        cluster: 'alertmeSwitchState',
        type: 'commandNotification',
        convert: (model, msg, publish, options, meta) => {
            //respSwitchStatus
            return {
                //each key in this object will exist in root tree json
                "RESP_SWITCH_STATUS": msg.data,
                "state": msg.data["switchState"] ? "ON" : "OFF"
            };
        }
    },
    //==CLUSTER POWER USAGE==
    alertmePowerUsageReport_fz: {
        cluster: 'alertmePowerUsage',
        type: 'commandNotification',
        convert: (model, msg, publish, options, meta) => {
            if ( msg.data.hasOwnProperty('watts') ) {
                //powerDemandReport
                /*
                    "POWER_DEMAND_REPORT": {
                            "watts": 0
                    },
                */
                return {
                    //each key in this object will exist in root tree json
                    "POWER_DEMAND_REPORT": msg.data
                };
            } else if ( msg.data.hasOwnProperty('powerConsumption') ) {
                //powerConsumptionReport
                /*
                    "POWER_CONSUMPTION_REPORT": {
                        "powerConsumption": 0,
                        "wasFirst": 0,
                        "uptimeSecs": 7630
                    },

                    assumption: uptime in seconds since paired.
                */
                return {
                    //each key in this object will exist in root tree json
                    "POWER_CONSUMPTION_REPORT": msg.data
                };
            } else if ( msg.data.hasOwnProperty('powerMeterUnknown') ) {
                //powerMeterUpdate
                return {
                    //each key in this object will exist in root tree json
                    "POWER_METER_UPDATE": msg.data
                };
            }
            
        }
    },
    //==CLUSTER JOIN==
    alertmeJoin_fz: {
        cluster: 'alertmeJoin',
        type: 'commandNotification',
        convert: (model, msg, publish, options, meta) => {
            if ( msg.data.hasOwnProperty('nodeId') ) {
                //respHello
                /*
                    "RESP_HELLO": {
                        "appRelease": 0,
                        "appVersion": 41,
                        "dateCode": "2013-09-26",
                        "deviceType": 7,
                        "eui64": "--SMARTPLUG_IEEE_ADDR--",
                        "hwMajorVersion": 1,
                        "hwMinorVersion": 0,
                        "mfg": "AlertMe.com",
                        "mfgId": 4153,
                        "model": "SmartPlug",
                        "nodeId": 24675
                    }
                */
                return {
                    //each key in this object will exist in root tree json
                    "RESP_HELLO": msg.data
                };
            } else if ( msg.data.hasOwnProperty('rssi') ) {
                //rangeTest
                /*
                    "RANGE_TEST": {
                        "lqi": 119,
                        "rssi": -44
                    },
                */
                return {
                    //each key in this object will exist in root tree json
                    "RANGE_TEST": msg.data
                };
            }
        }
    },
    //==CLUSTER GENERAL==
    alertmeDeviceGeneral_fz: {
        cluster: 'alertmeDeviceGeneral',
        type: 'commandNotification',
        convert: (model, msg, publish, options, meta) => {
            if ( msg.data.hasOwnProperty('manufId') ) {
                //================FaultReport====================
                const faults = [
                    "FAULT_NOFAULT",
                    "FAULT_EMBER_STACK_STARTUP",
                    "FAULT_WRONG_HARDWARE",
                    "FAULT_WRONG_HARDWARE_REVISION",
                    "FAULT_TOKEN_AREA_INVALID",
                    "FAULT_NO_BOOTLOADER",
                    "FAULT_NO_SERIAL_OUTPUT",
                    "FAULT_EMBER_MFGLIB_STARTUP",
                    "FAULT_FLASH_FAILED" ,
                    "FAULT_MCP23008_FAILED",
                    "FAULT_VERY_LOW_BATTERY",
                    "FAULT_FAILED_TO_FORM_NETWORK",
                    "FAULT_CHILD_DEVICE_LOST"
                ]

                let fault = msg.data.faultId;
  
                if ( fault >= faults.indexOf("FAULT_NOFAULT") && fault <= faults.indexOf("FAULT_CHILD_DEVICE_LOST") )
                    msg.data.faultId = faults[fault]

                return {
                        //each key in this object will exist in root tree json
                        "FAULT_REPORT": msg.data
                    };
                
            } else if ( msg.data.hasOwnProperty('statusFlags') ) {
                //================HeartBeat====================
                /*
                "RECV_HEARTBEAT": {
                        "lqi": 255, //always 255? doesn't work?
                        "uptimeMilliSecs": 975136,
                        "psuVoltage": 4731,
                        "rssi": -44,
                        "statusFlags": 31,
                        "switchMask": 1,
                        "switchState": 0,
                        "temperature": 476,
                        "tampered": 0
                    },
                    HAS_VOLTAGE = 1
                    HAS_TEMPERATURE = 2
                    HAS_SWITCH_STATE = 4
                    HAS_LQI = 8
                    HAS_RSSI = 16

                    MASK_TAMPER = 2
                    MASK_SENSOR = 1

                    STATE_TAMPER = 2
                    STATE_SENSOR = 1

                    assumption: uptime in milliseconds since powered.
                */
                
                let hasVoltage = msg.data.statusFlags & 1 ? true : false;
                let hasTemp = msg.data.statusFlags & 2 ? true : false;
                let hasState = msg.data.statusFlags & 4 ? true : false;
                let hasLqi = msg.data.statusFlags & 8 ? true : false;
                let hasRssi = msg.data.statusFlags & 16 ? true : false;
                let RECV_HEARTBEAT = {};

                if ( hasVoltage ) RECV_HEARTBEAT["psuVoltage"] = msg.data.psuVoltage;
                if ( hasTemp ) RECV_HEARTBEAT["temperature"] = msg.data.temperature;
                if ( hasState ) RECV_HEARTBEAT["switchState"] = msg.data.switchState;
                if ( hasLqi ) RECV_HEARTBEAT["lqi"] = msg.data.lqi;
                if ( hasRssi ) RECV_HEARTBEAT["rssi"] = msg.data.rssi;
                if ( msg.data.switchMask & 1 ) RECV_HEARTBEAT["switchState"] = msg.data.switchState & 1;
                if ( msg.data.switchMask & 2 ) RECV_HEARTBEAT["tampered"] = msg.data.switchState & 2;
                RECV_HEARTBEAT["uptimeMilliSecs"] = msg.data.uptimeMilliSecs;
                
                return {
                    //each key in this object will exist in root tree json
                    "RECV_HEARTBEAT": RECV_HEARTBEAT
                };
            } else if ( msg.data.hasOwnProperty('year') ) {
                //================GetRtc====================
                return {
                    //each key in this object will exist in root tree json
                    "GET_RTC": msg.data
                };
            } else if ( msg.data.hasOwnProperty('command') ) {
                //================GeneralCommand====================
                return {
                    //each key in this object will exist in root tree json
                    "GENERAL_COMMAND": msg.data
                };
            } else if ( msg.data.hasOwnProperty('msg') ) {
                //================StdOut====================
                return {
                    //each key in this object will exist in root tree json
                    "STD_OUT": msg.data
                };
            }
        }
    }
};
/*
    UI Interaction. set/get
    How to signal to the enddevice.

    key matches the exposes "property" kv.
*/
//==CLUSTER SWITCH_CONTROL==
const toZigbeeSwitchState = {
    RemoteMode: {
        //================switchButtonPermission (LED auto turns off over-time.) ====================
        //Can the physical switchButton be controlled remotely?
        key: ['RemoteMode'],
        convertSet: async (entity, key, value, meta) => {
            await entity.command("alertmeSwitchState","setRemoteMode",
                {
                    mode: value.includes("Local") ? REMOTE_FALSE : REMOTE_TRUE
                },
                alertmeOptions);
        },
    },
    SwitchState: {
        //================setSwitchState================
        key: ['state'],
        convertSet: async (entity, key, value, meta) => {
            /*
                tamper_switch = 2
                relay_switch = 1
            */
            let convVal = value == "ON" ? 1 : 0;
            await entity.command("alertmeSwitchState","setSwitchState",
                {
                    state: convVal,
                    relay_mask: 1

                },
                alertmeOptions);
        },
        //================reqSwitchStatus================ (stateResponse is triggered on switchState too.)
        convertGet: async (entity, key, meta) => {
            await entity.command("alertmeSwitchState","reqSwitchStatus",
                {
                },
                alertmeOptions);
        }
    }
}

//==CLUSTER POWER USAGE== - Nothing to send, only receive data. (Check advanced ame-power.irp files for more detail.)

//==CLUSTER DEVICE GENERAL==
const toZigbeeDeviceGeneral = {
    RTC: {
        key: ['RTC'],
        convertSet: async (entity, key, value, meta) => {
            let currentDate = new Date();
            let timezoneOffset = currentDate.getTimezoneOffset();
            await entity.command("alertmeDeviceGeneral","setRTC",
                {
                    year: currentDate.getFullYear(),
                    month: currentDate.getMonth() + 1,
                    dayOfMonth: currentDate.getDate(),
                    dayOfWeek: currentDate.getDay(),
                    hours: currentDate.getHours(),
                    minutes: currentDate.getMinutes(),
                    seconds: currentDate.getSeconds(),
                    timezone: timezoneOffset/60,
                    daylightSaving: 0
                },
                alertmeOptions);
        },
        convertGet: async (entity, key, meta) => {
            await entity.command("alertmeDeviceGeneral","getRTC",
                {
                },
                alertmeOptions);
        }
    },
    OperatingMode: {
        key: ['OperatingMode'],
        convertSet: async (entity, key, value, meta) => {
            let convVal = modes.indexOf(value);
            if ( convVal == -1 ) return;

            await entity.command("alertmeDeviceGeneral","setOperatingMode",
                {
                    mode: convVal,
                    home_network_flag: 0
                },
                alertmeOptions);
        }
    },
    //set to NormalMode with HNF set.
    HomeNetworkFlag: {
        key: ['HomeNetworkFlag'],
        convertSet: async (entity, key, value, meta) => {
            await entity.command("alertmeDeviceGeneral","setOperatingMode",
                {
                    mode: MODE_NORMAL,
                    home_network_flag: 1
                },
                alertmeOptions);
        }
    },
    UnpairPlug: {
        key: ['ClearNetworkFlag'],
        convertSet: async (entity, key, value, meta) => {
            await entity.command("alertmeDeviceGeneral","setOperatingMode",
                {
                    mode: MODE_NORMAL,
                    home_network_flag: 2
                },
                alertmeOptions);
        }
    },
    //Some claim this decreases heartbeat interval, but has no effect on my switch.
    DecreasePolling: {
        key: ['DecreasePolling'],
        convertSet: async (entity, key, value, meta) => {
            let copyObject = { ...alertmeOptions , disableDefaultResponse: false };
            await entity.command("alertmeDeviceGeneral","decreasePolling",
                {
                },
                alertmeOptions);
        }
    }
};

//==CLUSTER JOIN==
const toZigbeeJoin = {
    
    ReqHello: {
        key: ['ReqHello'],
        convertSet: async (entity, key, value, meta) => {
            await entity.command("alertmeJoin","reqHello",
                {
                },
                alertmeOptions);
        }
    },
    
};


function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function asyncWait(time) {
  await delay(time);
  console.log("Done!");
}

const definition = {
    //Put your smartplug ieeeaddr here to match it for loading this definition.
    //fingerprint: [{'ieeeAddr': "0x000d6f000416c4fc"}],
    fingerprint: [
        { 
            type: 'Router',
            manufId: 43981,
            endpoints: [
                //switch(238),power(239),general(240),led(241),tamper(242),button(243)
                {ID: 2, profileID: 49686, deviceID: 7, inputClusters: [240,243,241,239,238], outputClusters: []},
                {ID: 240, profileID: 49686, deviceID: 7, inputClusters: [2942,2943], outputClusters: []}
            ]
        }
    ],
    model: 'SPG900',
    description: 'Alertme Smart plug (with power monitoring)',
    vendor: 'Alertme/IrisV1',

    //receive clusters.
    fromZigbee: [
        fzLocal.alertmeSwitchState_fz,
        fzLocal.alertmePowerUsageReport_fz,
        fzLocal.alertmeDeviceGeneral_fz,
        fzLocal.alertmeJoin_fz,
    ],
    //send clusters+commands.
    toZigbee: [
        toZigbeeSwitchState.RemoteMode,
        toZigbeeSwitchState.SwitchState,

        toZigbeeDeviceGeneral.RTC,
        toZigbeeDeviceGeneral.OperatingMode,
        toZigbeeDeviceGeneral.DecreasePolling,
        toZigbeeDeviceGeneral.HomeNetworkFlag,
        toZigbeeDeviceGeneral.UnpairPlug,

        toZigbeeJoin.ReqHello
    ],
    
    //converterss/lib/exposes.js
    /*
        Should the ui display data? Or just perform read/write silently.

         ConvertSet(key, value)
           the value field will contain the below.
    */
    exposes: [
        /*
        const access = {
            STATE: 1, //show lastKnownState
            SET: 2, //The property can be set with a zigbee2mqtt/friendlyname/set mqtt command
            STATE_SET: 3, //combination
            STATE_GET: 5, //The property can be set with a zigbee2mqtt/friendlyname/get mqtt command
            ALL: 7,
        };
        access is unrelated to fromZigbee.
        name+property,access,values
        enum sets property to name too.

        calls .property to match .key of toZigbee object convertGet() convertSet()
        or matches a state variable returned from fromZigbee directly if ea.STATE only.
        */
        //e.switch(),//SwitchState
        e.enum("state",ea.STATE_SET,["ON","OFF"]),
        e.enum("RemoteMode",ea.STATE_SET,["Remote Mode","Local Mode"]),

        e.enum('RTC', ea.ALL, ["GET TIME"]),
        e.enum("OperatingMode",ea.STATE_SET,modes), 
        e.enum("DecreasePolling",ea.STATE_SET,["DECREASE POLLING"]),

        /*
        {   
            this.type = 'enum';
            this.name = "UNPAIR";
            this.property = "ClearNetworkFlag";
            this.access = ea.STATE_SET;
            this.values = ["UNPAIR"];
        }
        */
        e.enum("HomeNetworkFlag",ea.STATE_SET,["SET HOME NETWORK"]),
        e.enum("ClearNetworkFlag",ea.STATE_SET,["CLEAR HOME NETWORK"]),

        e.enum("ReqHello",ea.STATE_SET,["GET HELLO"]),

    ],

    /*
        Initial Mode after pairing is Dormant Mode.
        When re-inserted into plug socket, receives 1x Range Test 0xFD (rssi, lqi)
        Timers are reset when power is lost.
        uptimeMillisec timer in heartbeat is slightly fast/inaccurate/gains time
        uptimeSec timer more reliable in power consumption report
        HNF 2 == Unpair. I assume they just set HNF 1 with dormant mode, to make paired in driver.
    */
    configure: async (device, coordinatorEndpoint, logger) => {    
        const targEndpoint = device.getEndpoint(2);
        //use source endpoint 2. they like it.
        ameProfEndpoint = coordinatorEndpoint.getDevice().getEndpoint(2);

        //Binding optional?

        // await targEndpoint.bind("alertmeJoin",ameProfEndpoint);
        // await targEndpoint.bind("alertmeDeviceGeneral",ameProfEndpoint);
        // await targEndpoint.bind("alertmeSwitchState",ameProfEndpoint);

        //await targEndpoint.bind("alertmeUpgrade",ameProfEndpoint);
        //await targEndpoint.bind("alertmeTamper",ameProfEndpoint);


        //Turn remote LED back on periodically.
        /*
        let remoteMode = async () => {
            //Orange light like?
            await targEndpoint.command("alertmeSwitchState","setRemoteMode",
                {
                    mode: REMOTE_TRUE 
                },
                alertmeOptions);
        }
        
        remoteMode();
        clearInterval(remoteInterval);
        //in minutes
        remoteInterval = setInterval( remoteMode , 60000*remoteModeFrequency);
        */
        device.save();
    },
};

module.exports = definition;
