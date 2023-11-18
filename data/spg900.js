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

const HNF = 1;
const MODE_NORMAL = 0;
const MODE_RANGETEST = 1;
const MODE_LOCKED = 2;
const MODE_SEEKING = 3;
const MODE_IDLE = 4;
const MODE_DORMANT = 5;

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
    //alertmeSwitchState
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
    //alertmePowerUsage
    alertmePowerUsageReport_fz: {
        cluster: 'alertmePowerUsage',
        type: 'commandNotification',
        convert: (model, msg, publish, options, meta) => {
            if ( msg.data.hasOwnProperty('powerDemand') ) {
                //powerDemandReport
                return {
                    //each key in this object will exist in root tree json
                    "POWER_DEMAND_REPORT": msg.data
                };
            } else if ( msg.data.hasOwnProperty('powerConsumption') ) {
                //powerConsumptionReport
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
    //alertmeJoin
    alertmeJoin_fz: {
        cluster: 'alertmeJoin',
        type: 'commandNotification',
        convert: (model, msg, publish, options, meta) => {
            if ( msg.data.hasOwnProperty('nodeId') ) {
                //respHello
                return {
                    //each key in this object will exist in root tree json
                    "RESP_HELLO": msg.data
                };
            } else if ( msg.data.hasOwnProperty('rssi') ) {
                //rangeTest
                return {
                    //each key in this object will exist in root tree json
                    "RANGE_TEST": msg.data
                };
            }
        }
    },
    //alertmeDeviceGeneral
    alertmeDeviceGeneral_fz: {
        cluster: 'alertmeDeviceGeneral',
        type: 'commandNotification',
        convert: (model, msg, publish, options, meta) => {
            if ( msg.data.hasOwnProperty('manufId') ) {
                //FaultReport
                return {
                    //each key in this object will exist in root tree json
                    "FAULT_REPORT": msg.data
                };
            } else if ( msg.data.hasOwnProperty('statusFlags') ) {
                //recvHeartbeat
                return {
                    //each key in this object will exist in root tree json
                    "RECV_HEARTBEAT": msg.data
                };
            } else if ( msg.data.hasOwnProperty('year') ) {
                //getRTC
                return {
                    //each key in this object will exist in root tree json
                    "GET_RTC": msg.data
                };
            } else if ( msg.data.hasOwnProperty('command') ) {
                //GeneralCommand
                return {
                    //each key in this object will exist in root tree json
                    "GENERAL_COMMAND": msg.data
                };
            } else if ( msg.data.hasOwnProperty('msg') ) {
                //stdOut
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
//alertmeSwitchState
const toZigbeeSwitchState = {
    RemoteMode: {
        //setRemoteMode
        key: ['RemoteMode'],
        convertSet: async (entity, key, value, meta) => {
            await entity.command("alertmeSwitchState","setRemoteMode",
                {
                    mode: value.includes("Local") == -1 ? REMOTE_FALSE : REMOTE_TRUE
                },
                alertmeOptions);
        },
    },
    SwitchState: {
        //setSwitchState
        key: ['state'],
        convertSet: async (entity, key, value, meta) => {
            let convVal = value == "ON" ? 1 : 0;
            await entity.command("alertmeSwitchState","setSwitchState",
                {
                    state: convVal,
                    home_network_flag: HNF
                },
                alertmeOptions);
        },
        //reqSwitchStatus
        convertGet: async (entity, key, meta) => {
            await entity.command("alertmeSwitchState","reqSwitchStatus",
                {
                },
                alertmeOptions);
        }
    }
}

//alertmePowerUsage - none.

//alertmeDeviceGeneral
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
                    home_network_flag: HNF
                },
                alertmeOptions);
        }
    },
    DecreasePolling: {
        key: ['DecreasePolling'],
        convertSet: async (entity, key, value, meta) => {   
            await entity.command("alertmeDeviceGeneral","decreasePolling",
                {
                },
                alertmeOptions);
        }
    }
};

const toZigbeeJoin = {
    //alertmeJoin
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


let toggleme = 0;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function asyncWait(time) {
  await delay(time);
  console.log("Done!");
}

const definition = {
    fingerprint: [{'ieeeAddr': "0x000d6f000416c4fc"}],
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

        e.enum("ReqHello",ea.STATE_SET,["GET HELLO"]),

    ],
    //I think the below is for storing extra specific vendor/device information to customize cluster behaviour slightly.
    /*
    onEvent: async (type, data, device) => {
        if (type === 'message') {
            if ( data.cluster == 'alertmePowerUsage' ) {
                data.endpoint.saveClusterAttributeKeyValue('alertmePowerUsage', {uptime: data.data['uptime']});
            }
        }
    },*/ 
    configure: async (device, coordinatorEndpoint, logger) => {    
        const targEndpoint = device.getEndpoint(2);
        //use source endpoint 2. they like it.
        ameProfEndpoint = coordinatorEndpoint.getDevice().getEndpoint(2);

        // await targEndpoint.bind("alertmeJoin",ameProfEndpoint);
        // await targEndpoint.bind("alertmeDeviceGeneral",ameProfEndpoint);
        // await targEndpoint.bind("alertmeSwitchState",ameProfEndpoint);

        //await targEndpoint.bind("alertmeUpgrade",ameProfEndpoint);
        //await targEndpoint.bind("alertmeTamper",ameProfEndpoint);


        let remoteMode = async () => {
            //Orange light like?
            await targEndpoint.command("alertmeSwitchState","setRemoteMode",
                {
                    mode: REMOTE_TRUE 
                },
                alertmeOptions);
        }
        
        //remoteMode();
        //clearInterval(remoteInterval);
        //remoteInterval = setInterval( remoteMode , 60000*remoteModeFrequency);

        device.save();

    },
};

module.exports = definition;