var async = require('async');
var request = require('request');
var DockerEvents = require('docker-events'),
    Dockerode = require('dockerode')
var docker = new Dockerode({socketPath: '/var/run/docker.sock'});
var emitter = new DockerEvents({
    docker: docker,
});

var _prefix = process.env.SVC_PREFIX || "";
var _consulAgent = process.env.LOCAL_CONSUL_AGENT || "http://localhost:8500";
var _consulToken = process.env.CONSUL_HTTP_TOKEN || "";
var _startupTimeout = process.env.STARTUP_DELAY_TIMER || 30;

emitter.start();

emitter.on("connect", function(){
    console.log("connected to docker api");
});

emitter.on("start", function(evt){

    var name = evt.Actor.Attributes['io.rancher.container.name'] || evt.Actor.Attributes.name;
    console.log(new Date() + " - container start " + name + " (image : " + evt.Actor.Attributes.image + ")");
    getMetaData(name)
        .then(getAgentIP)
        .then(checkForPortMapping)
        .then(checkForServiceIgnoreLabel)
        .then(checkForServiceNameLabel)
        .then(checkForServiceTagsLabel)
        .then(checkForHealthCheckLabel)
        .then(registerService)
        .then(function(value){
            console.log(value);
        }).catch(function(err){
            console.log("Registering ERROR : " + err);
        })
});

emitter.on("stop", function(evt){

    var name = evt.Actor.Attributes['io.rancher.container.name'] || evt.Actor.Attributes.name;
    console.log(new Date() + " - container stop " + name + " (image : " + evt.Actor.Attributes.image + ")");

    getMetaData(name)
        .then(getAgentIP)
        .then(checkForPortMapping)
        .then(deregisterService)
        .then(function(value){
            console.log(value);
        }).catch(function(err){
            console.log("Deregistering ERROR : " + err);
        })
});

setTimeout(function(){

    console.log(new Date() + " - registrator startup loop started");
    docker.listContainers(function(err, containers){
        containers.forEach(function(cont){
            var container = docker.getContainer(cont.Id);
            container.inspect(function(err, data){
                var name = data.Config.Labels['io.rancher.container.name'] || data.Name;
                console.log(new Date() + " - container found " + name + " (image : " + data.Image + ")");
                getMetaData(name)
                    .then(getAgentIP)
                    .then(checkForPortMapping)
                    .then(checkForServiceIgnoreLabel)
                    .then(checkForServiceNameLabel)
                    .then(checkForServiceTagsLabel)
                    .then(checkForHealthCheckLabel)
                    .then(registerService)
                    .then(function(value){
                        console.log(value);
                    }).catch(function(err){
                        console.log("Registering ERROR : " + err);
                    })
            });
        });
    });
    console.log(new Date() + " - registrator startup loop finished");
}, _startupTimeout * 1000);

function getMetaData(servicename){
    return new Promise(
        function(resolve,reject){
            var query = {
                "method":"GET",
                "url": "http://rancher-metadata/latest/containers/" + servicename,
                "headers":{
                    "accept" : "application/json"
                }
            }

            request(query,function (error, response, body){
                if(error){
                    reject("getMetaData error : " + error);
                }
                else{
                    var output = {};
                    output.metadata = JSON.parse(body);
                    output.servicename = servicename;
                    resolve(output);
                }
            })
        }
    )
}

function getAgentIP(input){
    return new Promise(
        function(resolve,reject){
            var query = {
                "method":"GET",
                "url": "http://rancher-metadata/latest/self/host",
                "headers":{
                    "accept" : "application/json"
                }
            }

            request(query,function (error, response, body){
                if(error){
                    reject("getAgentIP error : " + error);
                }
                else{
                    input.metadata.hostIP = JSON.parse(body).agent_ip;
                    resolve(input);
                }
            })
        }
    )
}

function checkForPortMapping(input){
    return new Promise(
        function(resolve,reject){
            if(input.metadata.ports.length > 0){
                input.metadata.portMapping = [];
                input.metadata.ports.forEach(function(pm){
                    var portMapping = pm.split(":");
                    var internal = portMapping[2].split("/");
                    var ip = input.metadata.hostIP;
                    input.metadata.portMapping.push({"address":ip,"publicPort":portMapping[1],"privatePort":internal[0],"transport":internal[1]});
                })
                resolve(input);
            }
            else{
                reject("No need to register this service");
            }
        }
    )
}

function checkForServiceIgnoreLabel(input){
    return new Promise(
        function(resolve,reject){
            if(input.metadata.labels.SERVICE_IGNORE){
                console.log("Service_Ignore found");
                reject("Service ignored");
            }
            else{
                resolve(input);
            }

        }
    )
}

function checkForServiceNameLabel(input){
    return new Promise(
        function(resolve,reject){
            if(input.metadata.labels.SERVICE_NAME){
                console.log("Service_Name found");
                input.metadata.service_name = input.metadata.labels.SERVICE_NAME;
            }
            resolve(input);
        }
    )
}

function checkForServiceTagsLabel(input){
    return new Promise(
        function(resolve,reject){
            if(input.metadata.labels.SERVICE_TAGS){
                console.log("Service_Tags found");
                input.metadata.service_tags = input.metadata.labels.SERVICE_TAGS.split(",");
            }
            resolve(input);
        }
    )
}

function checkForHealthCheckLabel(input){
    return new Promise(
        function(resolve,reject){

            //We create a structure like that
            //checks[port_number].id
            //checks[port_number].name
            //checks[port_number].http
            //...
            var checks = {};

            for(var key in input.metadata.labels){
                if(input.metadata.labels.hasOwnProperty(key)){

                    //Check if SERVICE_XXX_CHECK_HTTP/HTTPS/TCP/SCRIPT/TTL is there
                    //Update switch statement below if you add to this
                    var checkPattern = /^SERVICE_(\d+)_CHECK_(HTTPS?|TCP|SCRIPT|TTL)$/g;
                    var checkMatch = checkPattern.exec(key);

                    //indice 1 of checkMatch contains the private port number
                    if(checkMatch){

                        //stucture init for the captured port
                        if(!checks[checkMatch[1]])
                            checks[checkMatch[1]] = {};

                        checks[checkMatch[1]].id =  input.metadata.name + "_" + checkMatch[0];
                        checks[checkMatch[1]].name =  input.metadata.name + "_" + checkMatch[0];
                        checks[checkMatch[1]].interval = "10s";
                        checks[checkMatch[1]].timeout = "1s";

                        var obj = jsonQuery('portMapping[privatePort=' + checkMatch[1] + ']', {
                            data: {"portMapping":input.metadata.portMapping}
                        });

                        //indice 2 of checkMatch contains the check type
                        switch(checkMatch[2]){
                            case 'HTTP':
                                checks[checkMatch[1]].http = "http://" + input.metadata.hostIP + ":" + obj.value.publicPort + input.metadata.labels[key];
                                break;
                            case 'HTTPS':
                                checks[checkMatch[1]].http = "https://" + input.metadata.hostIP + ":" + obj.value.publicPort + input.metadata.labels[key];
                                break;
                            case 'TCP':
                                if(input.metadata.labels[key].toLowerCase() == "true")
                                    checks[checkMatch[1]].tcp = input.metadata.hostIP + ":" + obj.value.publicPort;
                                break;
                            case 'SCRIPT':
                                checks[checkMatch[1]].script = input.metadata.labels[key].replace("$SERVICE_IP", input.metadata.hostIP).replace("$SERVICE_PORT", obj.value.publicPort);
                                break;
                            case 'TTL':
                                checks[checkMatch[1]].ttl = input.metadata.labels[key];
                                break;
                            default:
                                //This should never happen
                                reject("Unmatched check " + checkMatch[2]);
                        }
                    }

                    //Then, check if SERVICE_XXX_CHECK_INTERVAL is there
                    var intervalPattern = /^SERVICE_(\d+)_CHECK_INTERVAL$/g;
                    var intervalMatch = intervalPattern.exec(key);

                    if(intervalMatch){

                        if(!checks[intervalMatch[1]])
                            checks[intervalMatch[1]] = {};

                        checks[intervalMatch[1]].interval =  input.metadata.labels[key];
                    }

                    //Then, check if SERVICE_XXX_CHECK_TIMEOUT is there
                    var timeoutPattern = /^SERVICE_(\d+)_CHECK_TIMEOUT$/g;
                    var timeoutMatch = timeoutPattern.exec(key);

                    if(timeoutMatch){

                        if(!checks[timeoutMatch[1]])
                            checks[timeoutMatch[1]] = {};

                        checks[timeoutMatch[1]].timeout =  input.metadata.labels[key];
                    }

                    //Then, check if SERVICE_XXX_INITIAL_STATUS is there
                    var statusPattern = /^SERVICE_(\d+)_INITIAL_STATUS$/g;
                    var statusMatch = statusPattern.exec(key);

                    if(statusMatch){

                        if(!checks[statusMatch[1]])
                            checks[statusMatch[1]] = {};

                        checks[statusMatch[1]].status =  input.metadata.labels[key];
                    }
                }
            }

            //Add checks in metadata for each port mapping
            input.metadata.portMapping.forEach(function(item){
                if(checks[item.privatePort]){
                    if(checks[item.privatePort].ttl){
                        delete checks[item.privatePort].interval;
                        delete checks[item.privatePort].timeout;
                    }
                    item.Check = checks[item.privatePort];
                }
            })

            resolve(input);
        }
    )
}

function registerService(input){
    return new Promise(
        function(resolve,reject){
            var serviceDefs = [];
            input.metadata.portMapping.forEach(function(pm){

                var id = input.metadata.uuid + ":" + pm.publicPort;
                var name = _prefix + input.metadata.service_name;
                if(pm.transport == "udp")
                    id += ":udp";

                if(input.metadata.portMapping.length > 1)
                    name += "-" + pm.privatePort;

                var definition = {
                    "ID": id, //<uuid>:<exposed-port>[:udp if udp]
                    "Name": name,
                    "Address": pm.address,
                    "Port": parseInt(pm.publicPort)
                };

                if(input.metadata.service_tags)
                    definition.Tags = input.metadata.service_tags;

                if(pm.Check)
                    definition.Check = pm.Check;

                serviceDefs.push(definition);

            })

            async.map(serviceDefs,doRegister,function(err,results){
                if(err)
                    console.log(err);
                resolve(results);
            });
        }
    )
}

function deregisterService(input){
    return new Promise(
        function(resolve,reject){

            var uniqueIDs = [];

            input.metadata.portMapping.forEach(function(pm){
                var id = input.metadata.uuid + ":" + pm.publicPort;

                if(pm.transport == "udp")
                    id += ":udp";
                uniqueIDs.push(id);
            });

            async.map(uniqueIDs,doDeregister,function(err,results){
                if(err)
                    console.log(err);
                resolve(results);
            });
        }
    )
}

function doRegister(serviceDef,callback){
    var query = {
        "method":"PUT",
        "url": _consulAgent + "/v1/agent/service/register",
        "qs":{
            "token" : _consulToken
        },
        "headers":{
            "Content-Type" : "application/json"
        },
        "json":serviceDef
    };

    request(query,function (error, response, body){
        if(error){
            callback("registerService error : " + error,null);
        }
        else{
            callback(null,serviceDef.ID + " registered");
        }
    });
}

function doDeregister(uuid,callback){
    var query = {
        "method":"GET",
        "url": _consulAgent + "/v1/agent/service/deregister/" + uuid,
        "qs":{
            "token" : _consulToken
        },
    };

    request(query,function (error, response, body){
        if(error){
            callback("deregisterService error : " + error,null);
        }
        else{
            callback(null,uuid + " deregistered");
        }
    });
}
