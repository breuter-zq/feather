var simpleId = require("./simple-id"),
    ns = require("./ns"),
    _ = require("underscore")._,
    inherits = require("inherits"),
    EventPublisher = require("./event-publisher"),
    Registry = require("./registry"),
    Semaphore = require("./semaphore"),
    BaseClass = require("./base-class"),
    FSM = require("./fsm"),
    Logger = require("./logger"),
    Widget = require("./widget"),
    DomPool = require("./dom").DomPool,
    DomResource = require("./dom").DomResource,
    cache = require("./simple-cache"),
    uuid = require("node-uuid"),
    util = require("./util"),
    server = require("./server"),
    socket = require("./socket"),
    auth = require("./auth"),
    nodePath = require("path");

/**
 * @namespace serves as the root namespace for the entire framework
 * @name feather
 */
var feather = module.exports = /** @lends feather */ {

  /**
   * Alias to the simpleId module
   */
  id: simpleId,

  /**
   * Alias to the namespace module
   */
  ns: ns,

  /**
   * Uses ns to get a config value at a path (or null if path not found)
   * 
   */
  config: function(path) {
    return feather.ns(path, feather.appOptions, true);
  },

  /**
   * Alias to the Util module's recursiveExtend function
   */
  recursiveExtend: util.recursiveExtend,

  /**
   * Alias to mkdirpsync
   */
  mkdirpSync: util.mkdirpSync,
  
  /**
   * Flyweight empty Function
   * @memberOf feather
   */
  emptyFn: function() {},
  
  /**
   * Flyweight empty Object
   */
  emptyObj: {},
  
  /**
   * Flyweight empty String
   */
  emptyString: "",
  
  /**
   * Flyweight empty Array
   */
  emptyArray: [],

  /**
   * Reference to {@link SimpleCache}
   */
  cache: cache,

  /**
   * Framework init function
   * @param {Object} options
   */
  init: function(options) {

    options = options || {};
    options.featherRoot = options.featherRoot || "./";
    options.appRoot = options.appRoot || __dirname;
    options.publicRoot = options.publicRoot || options.appRoot + "/public";
    options.port = options.port || 8080;
    options.socketPort = options.socketPort || 8081;
    options.states = options.states || {};
    options.states.ready = options.states.ready || {
      request: function(fsm, args) {
        var res = args.eventArgs.response;
        res.writeHead(200, {'Content-Type': 'text/plain'});
        res.end('feather was started with no custom request handler.\n');
      }  
    };
    
    //store a read-only copy of options in cache so that other modules
    //can inspect original options reliably
    var cacheToken = uuid();
    cache.setItemReadOnly("feather-options", options, cacheToken);
    //store an unprotected copy for convenience 
    feather.appOptions = options;

    /**
     * A dom resource singleton in the feather namespace
     * @name feather.domPool
     * @see DomPool
     */
    feather.dom = new DomResource({
      onState: {
        ready: function() {
          cache.setItem("feather-dom", feather.dom);
        }
      }
    });    

    /**
     * A dom pool in the feather namespace
     * @name feather.domPool
     * @see DomPool
     */
    feather.domPool = new DomPool(options.domPoolSize);
    cache.setItem("feather-domPool", feather.domPool);

    feather.stateMachine = new FSM({
      states: {
        initial: {
          stateStartup: function() {
            //add a hook for clean shutdown to the process itself.
            this.onceState("ready", function() {
              process.on('SIGINT', feather.shutdown);
              process.on('SIGTERM', feather.shutdown);
            });          
            //go right to the "loading state" since that is exactly what we're doing at the time this instance is created
            return this.states.loading;
          }
        },
        loading: {
          ready: function() {
            //once everything is loaded, go to the ready state
            return this.states.ready;
          }
        },
        ready: {
          stateStartup: function() {
            if (options.onReady && typeof(options.onReady) === 'function') {
              options.onReady(feather);
              options.onReady = null;
            }
          }
        }
      }
    });
    cache.setItem("feather-stateMachine", feather.stateMachine);

    // logger.js stuff
    feather.logger = new feather.logging.Logger(options.logging);
    if (options.onLoggerReady && typeof(options.onLoggerReady) === 'function') {
      // TODO: change to flight services APIs once implemented
      options.onLoggerReady(feather.logger);
      options.onLoggerReady = null;
    }
    cache.setItem("feather-logger", feather.logger);

    //handle uncaught exceptions              
    process.on("uncaughtException", function(err) {
      var message = err;
      if (err.stack) {
        message += "\n" + err.stack;
      }
      feather.logger.error({message: message, category: "feather.uncaughtException"});
    });

    // Data stuff
    var dataInterface = null;
    if (options.data.appdb || options.data.authdb) {
      dataInterface = require("./data");
    }
    if (options.data.appdb) {
      /**
       * Provides access to the application database.
       */
      feather.data.appdb = new dataInterface(options.data.appdb);
      cache.setItem("feather-appdb", feather.data.appdb);
    }
    if (options.data.authdb) {
      /**
       * Provides access to the authorization database.
       */
      feather.data.authdb = new dataInterface(options.data.authdb);
      cache.setItem("feather-authdb", feather.data.authdb);
    }

    //pass feather into app as a require-able module if lib/feather.js is found in the app (should be added via CLI when the app is created)
    var fPath = options.appRoot + "/lib/feather.js";
    if (nodePath.existsSync(fPath)) {
      var _f = require(fPath);
      _f.init(feather);
    }

    var initServer = function() {
      server.init(options, function(err, _server, _mirror) {
        if (err) throw err;

        _server.on("close", function(errno) {
          feather.logger.warn({message:"feather server shutting down.", category:'feather.srvr', immediately:true});
        });

        feather.server = _server;
        cache.setItem("feather-server", _server);

        if (_mirror) cache.setItem("feather-server-mirror", _mirror);
        
        //create a proxy method for registering rest routes in the server(s)
        cache.getItems([
          "feather-rest",
          "feather-rest-mirror"
        ], function(err, items) {
          var rest = items["feather-rest"],
            restMirror = items["feather-rest-mirror"];

          feather.rest = {
            registerRoute: function(verb, routePath, routeFn, cb) {
              var err = null;
              if (rest) {
                rest.registerRoute.call(rest, verb, routePath, routeFn, function(_err) {
                  if (!err) err = _err;
                });
              }
              if (restMirror) {
                restMirror.registerRoute.call(restMirror, verb, routePath, routeFn, function(_err) {
                  if (!err) err = _err;
                });
              }
              cb && cb(err);
            }
          };
        });

        function completeFeatherSetup() {
          require("./server.loadwidget");

          if (feather.appOptions.auth.enabled) {
            feather.auth = require("./auth");
          }

          feather.logger.warn({message:"feather server listening on port: " + options.port + ".  Welcome to feather!", category:"feather.srvr"});

          //now finally make the move to the ready state
          feather.stateMachine.fire("ready");
        }

        //start up the socket server (if enabled)
        if (options["socket.io"].enabled) {
          socket.init(options, function(err, socketServer) {
            if (err) throw err;

            feather.socketServer = socketServer;
            cache.setItem("feather-socketServer", socketServer);

            completeFeatherSetup();
          });
        } else {
          completeFeatherSetup();
        }
      });
    };

    if (options.onInit && typeof(options.onInit) === 'function') {
      options.onInit(feather, initServer);
      options.onInit = null;
    } else {
      initServer();
    }

    
  },
  
  /**
   * Shuts down the server cleanly, but not before it is ready for requests.
   */
  shutdown: function() {
    if (feather.stateMachine) {
      feather.stateMachine.onceState("ready", function() {
        if (feather.server) {
          try {
            feather.server.close && feather.server.close();
            if (feather.server.httpServer && feather.server.httpServer.close) {
              feather.server.httpServer.close();
            }
          } catch (exception) {
            feather.logger.error({message: "Error while shutting down http server: " + exception.message, category:'feather.srvr', exception: exception, immediately:true});
          }
          //process.exit(0);
        } else {
          feather.logger.error({message:"feather server cannot shut down.  feather.server is undefined", category:"feather.srvr", immediately:true});
        }
        if (feather.appOptions["socket.io"].enabled) {
          if (feather.socketServer) {
            try {
              feather.socketServer.server.close();
            } catch (exception) {
              feather.logger.error({message: "Error while shutting down socket server: " + exception.message, category:'feather.srvr', exception: exception, immediately:true});
            }

          } else {
            feather.logger.error({message:"feather socket server cannot shut down.  feather.socketServer is undefined", category:"feather.srvr", immediately:true});
          }
        }
        feather.logger.dispose();
        process.nextTick(function() {
          process.exit(0);
        });
      });
    } else {
      feather.logger.error({message:"feather server cannot shut down.  feather.stateMachine is undefined", category:"feather.srvr", immediately:true});
    }
  }, // end shutdown.
  
  /**
   * This function is used to start the feather engine.
   */
  start: function(options) {
    options = options || {};
    
    if (options.daemon.runAsDaemon) {
      var daemon = require("daemon");
      daemon.daemonize(options.daemon.outputPath, options.daemon.pidPath, function(err, pid) {
        feather.init(options);
      });
    } else {
      feather.init(options);
    }
  },

  /**
   * @namespace Root namespace for data class definitions and services
   * @name feather.data
   */
  data: {
    // Content is added in init function.
  },

  /**
   * @namespace provides the lang namespace inside of the framework
   * @name feather.lang
   */
  lang: {
    /**
     * Framework access to {@link BaseClass}
     */
    BaseClass: BaseClass,
    /**
     * Framework access to {@link Registry}
     */
    Registry: Registry,
    /**
     * Framework access to {@link Semaphore}
     */
    Semaphore: Semaphore
  },

  /**
   * @namespace Root namespace for Finite State Machine class definitions and services
   * @name feather.fsm
   */
  fsm: {    
    /**
     *  Framework access to {@link FiniteStateMachine} class.
     */ 
    FiniteStateMachine: FSM
  }, 

  event: {
    EventPublisher: EventPublisher
  },

  /**
   * @namespace contains all things related to logging.
   * @name feather.logging
   */
  logging: {
    /**
     * Framework access to {@link Logger} class.
     */
    Logger: Logger
  },

  /**
   * @namespace contains all things related to public REST api.
   * @name feather.rest
   */
  rest: null, // set up later in router init.

  /**
   * Framework access to {@link Widget}
   */
  Widget: Widget,

  /**
   * 
   */
  socket: socket
}; // end exports.feather
//console.log(require("util").inspect(feather));