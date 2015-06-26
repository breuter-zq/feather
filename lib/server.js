var tls             = require("tls"),
    fs              = require("fs"),
    http            = require("http"),
    https           = require("https"),
    Connect         = require("connect"),
    EventPublisher  = require("./event-publisher"),
    FSM             = require("./fsm"),
    Semaphore       = require("./semaphore"),
    indexer         = require("./file-indexer"),
    parser          = require("./parser"),
    fileWatcher     = require("./filewatcher"),
    watch           = require("watch"),
    middleware      = require("./middleware"),
    cache           = require("./simple-cache"),
    _               = require("underscore")._,
    restProxy       = require("./restProxy"),
    connectRouter   = require("./router_connect"),
    console         = require("console"),
    ResourcePackager = require("./resource-packager"),
    constants       = require('constants');

exports.init = function(options, cb) {

  //use a state machine to package/parse required application resources
  var fsm = new FSM({
    states: {
      initial: {
        stateStartup: function() {
          // - index the application's files and directories
          indexer.index(options, function(err, indexedFiles) {
            if (err) fsm.fire("error", err); else {
              cache.setItem("feather-files", indexedFiles);

              // now that feather is cluster-aware, only the master process should parse
              if (options.isMaster) {

                if (indexedFiles.restFiles && options.rest && options.rest.autoGenerateProxy) {
                  fsm.fire("generateRestProxy", indexedFiles);
                } else {
                  fsm.fire("parseFeatherFiles", indexedFiles, null);
                }

              } else {
                fsm.fire("parsingComplete");
              }
            }
          });
        },
        generateRestProxy: function(indexedFiles) {
          restProxy.generateProxy({
            appOptions: options,
            files: indexedFiles.restFiles
          }, function(err, restProxyInfo) {
            if (err) cb(err); else {
              fsm.fire("parseFeatherFiles", indexedFiles);
            }
          });
        },
        parseFeatherFiles: function(indexedFiles) {
          // - pre-parse all feather.html files
          // - move the stateMachine to the next state
          var sem = new Semaphore(function() {
            fsm.fire("parsingComplete");
          });

          //parse the .feather.html files in the app
          sem.increment();
          _.each(_.keys(indexedFiles.featherFiles), function(_path) {
            sem.increment();
            //guarantee all files get counted in semaphore
            process.nextTick(function() {
              parser.parseFile({
                path: _path,
                fileMetaData: indexedFiles.featherFiles[_path],
                request: {page: _path.replace(/.*\/public\/(.*)$/, "$1")} //need a dummy request object for parser since there is no real request at this point
              }, function(err, result) {
                  if (err) throw new Error(JSON.stringify(err)); else {

                    //TODO: figure out gracefully re-publishing changed files w/ watchers... (commenting out for now as a placeholder)
                    // if (!indexedFiles.featherFiles[_path].watchingFile) { //only wire the watcher once
                    //   fileWatcher.watchFileMtime(_path, function(args) {
                    //     // TODO: Trigger a reparse and republish of the page (with clustered processes this could be a messy resource contention issue).
                    //   });
                    //   indexedFiles.featherFiles[_path].watchingFile = true;
                    // }

                    sem.execute();
                  }
              });
            });
          });
          sem.execute();
        },
        parsingComplete: function() {
          if (options.isMaster && options.developer.watchForChanges) {
            // Only the master should watch.
            cache.getItemsWait(['feather-files', 'feather-logger'], function(cacheErr, cacheItems) {
              var indexedFiles = cacheItems['feather-files'],
                  logger = cacheItems['feather-logger'];

              watch.createMonitor(options.publicRoot, {
                ignoreDotFiles: true,
                filter: function(filePath) {
                  var ret = filePath.indexOf('feather-res-cache') === -1 && !!filePath.match(/\.(feather|template)\.html$/); // only watch feather files.
                  if (ret) logger.debug({message:"Including " + filePath + " in watch list.", category: "feather.server" });
                  return ret;
                }
              }, function(monitor) {
                logger.info({ message: "Watching feather files and templates for changes.", category: "feather.server" });
                var processChange = function(filename, stat) {
                  if (filename.indexOf('feather-res-cache') === -1 && !!filename.match(/\.(feather|template)\.html$/)) {
                    logger.info({ message: "Processing " + filename + " due to a change", category: "feather.server" });
                    if (filename.match(/\.template.html$/)) { // widget template.  re-parse all pages that use it.

                      // Re-read the template file and replace in the index.
                      fs.readFile(filename, "utf-8", function(fileErr, templateData) {
                        indexedFiles.templateFiles[filename]  = {
                          stats: stat,
                          data: indexer.adjustTemplateData(templateData)
                        };

                        var featherFileMetaData;
                        _.each(_.keys(indexedFiles.featherFiles), function(featherFilePath) {
                          featherFileMetaData = indexedFiles.featherFiles[featherFilePath];
                          if (featherFileMetaData.widgets[filename]) { // If this feather file uses the widget template..
                            process.nextTick(function() {
                              parser.parseFile({
                                forceReparse: true,
                                path: featherFilePath,
                                fileMetaData: featherFileMetaData,
                                request: {page: filename.replace(/.*\/public\/(.*)$/, "$1")} //need a dummy request object for parser since there is no real request at this point
                              }, function(err, result) {
                                  if (err) logger.error(err); else logger.info({ message: "Re-parsed " + featherFilePath + " due to a change in " + filename, category: "feather.server" });
                              });
                            });
                          }
                        });
                      });
                    } else { // feather file.  re-parse the page.

                      process.nextTick(function() {
                        parser.parseFile({
                          path: filename,
                          forceReparse: true,
                          fileMetaData: indexedFiles.featherFiles[filename],
                          request: {page: filename.replace(/.*\/public\/(.*)$/, "$1")} //need a dummy request object for parser since there is no real request at this point
                        }, function(err, result) {
                            if (err) logger.error(err); else logger.info({ message: "Re-parsed " + filename, category: "feather.server" });
                        });
                      });
                    }
                  };
                }
                monitor.on('created', function(f, stat) {
                  processChange(f, stat);
                });
                monitor.on('changed', function(f, currStat, prevStat) {
                  processChange(f, currStat);
                });
              });
            });
          }

          if (!options.isWorker) {
            return fsm.states.complete; //the actual server bindings should only happen in the workers
          } else {
            return fsm.states.processCss;
          }
        }
      },
      processCss: {
        stateStartup: function() {
          if (options.resources.publish.compileToSingleCss) {

            ResourcePackager.packageSingleCssFile({
              appOptions: options
            }, function(err) {
              fsm.fire('complete');
            });

          } else {
            return fsm.states.createServer;
          }
        },

        complete: function() {
          return fsm.states.createServer;
        }

      },
      createServer: {
        stateStartup: function() {

          //first create the session store
          var sessionStore,
            provider = options.connect.session.provider;

          switch (provider) {
            case "memory":
              if (options.cluster) {
                fsm.fire('error', 'When clustering, you cannot use the default memory store for session.');
              } else {
                sessionStore = new Connect.session.MemoryStore;
                cache.setItem("feather-sessionStore", sessionStore);
                options.connect.session.store = sessionStore;
                getMiddleware(sessionStore);
              }
              break;

            case "redis":
              var RedisStore = require("connect-redis")(Connect);
              var redisOptions = null;
              // If providerOptions is specified, look at the server value.
              // If not, look to see if redis.servers.session exists.  Otherwise just use defaults.
              if (options.connect.session.providerOptions && options.connect.session.providerOptions.server) {
                redisOptions = options.redis.servers[options.connect.session.providerOptions.server];
              } else {
                redisOptions = options.redis.servers.session || {};
              }

              sessionStore = new RedisStore(redisOptions);
              cache.setItem("feather-sessionStore", sessionStore);
              options.connect.session.store = sessionStore;
              getMiddleware(sessionStore);
              break;

            case "custom":
              if (typeof options.getSessionStore === "function") {
                options.getSessionStore(function(err, sessionStore) {
                  if (err) throw err;

                  getMiddleware(sessionStore);
                });
              } else {
                throw new Error('When "custom" is specified for connect.session.provider, you must implement a getSessionStore(cb) method in your app.js file.');
              }
              break;
          }

          //TODO: use getSessionStore or something like that...

          function getMiddleware(sessionStore) {
            middleware.getMiddleware(options, function(err, _middleware, _restRouter) {
              if (err) fsm.fire("error", err); else {
                var mirror = null,
                  deferCompletion = false,
                  tlsOptions;

                //stash the rest interface
                cache.setItem("feather-rest-router", _restRouter);
                cache.setItem("feather-rest", _restRouter.rest);

                //defer final server setup until SSL/mirroring is sorted out below
                var completeServerSetup = function() {
                  //create the underlying Connect server instance
                  var server = Connect();
                  _.each(_middleware, function(ware) {
                    server.use(ware);
                  });

                  // configure session path ignores
                  if (options.connect.session.ignorePaths && server.session) {
                    var si = options.connect.session.ignorePaths.length-1;
                    while (si >= 0) {
                      server.session.ignore.push(options.connect.session.ignorePaths[si]);
                      si -= 1;
                    }
                  }

                  //start listening
                  var port = options.port;
                  if (options.ssl && options.ssl.enabled && options.ssl.port) port = options.ssl.port;

                  if (options.ssl && options.ssl.enabled) {
                    server.httpServer = https.createServer(tlsOptions, server).listen(port);
                  } else {
                    server.httpServer = http.createServer(server).listen(port);
                  }

                  // now that ports have been bound we can change the process user and group
                  if (options.daemon.runAsDaemon == true && options.daemon.runAsUser) {

                    console.debug('setting process and group ids (eval whether this should happen for clustered workers or just group leader - then remove debug log statement)...');

                    if (process.env['USER'] === 'root') {
                      if (options.daemon.runAsGroup) {
                        process.setgid(options.daemon.runAsGroup);
                      }

                      process.setuid(options.daemon.runAsUser);
                    }
                  }

                  server.sessionStore = sessionStore;
                  fsm.fire("complete", server, mirror);
                };

                //use ssl?
                if (options.ssl && options.ssl.enabled) {
                  if (options.ssl.routes && (!options.ssl.port || options.ssl.port == options.port)) {
                    throw new Error("When explicit SSL routes are defined, you must also specify a value for ssl.port which must be different from the top level (non-SSL) port.");
                  }

                  tlsOptions = {
                    // This is the default secureProtocol used by Node.js, but it might be
                    // sane to specify this by default as it's required if you want to
                    // remove supported protocols from the list. This protocol supports:
                    //
                    // - SSLv2, SSLv3, TLSv1, TLSv1.1 and TLSv1.2
                    //
                    secureProtocol: 'SSLv23_method',
                    key: fs.readFileSync(options.ssl.key),
                    cert: fs.readFileSync(options.ssl.cert)
                  };

                  // disable SSLv2 and SSLv3 by default to prevent POODLE exploit
                  // There is a bit of a debate on when this will appear in node core 
                  // and whether it will be on or off by default. https://github.com/joyent/node/pull/8551
                  // This current solution will work until the Node community decides.
                  if (!options.ssl.allowSSLv23) {

                    // Supply `SSL_OP_NO_SSLv3` and `SSL_OP_NO_SSLv2` constant as secureOption to disable SSLv2 and SSLv3
                    // from the list of supported protocols that SSLv23_method supports.
                    tlsOptions.secureOptions = constants.SSL_OP_NO_SSLv3|constants.SSL_OP_NO_SSLv2;
                  }

                  if (options.ssl.ca) {
                    tlsOptions.ca = [];
                    _.each(options.ssl.ca, function(ca) {
                      var certs = fs.readFileSync(ca);
                      tlsOptions.ca.push(certs);
                    });
                  }
                  _middleware.unshift(tlsOptions);

                  if (options.ssl.useRedirectServer && !options.ssl.routes) {
                    //ssl is configured as "strict, always on" - i.e. no explicit ssl routes are defined,
                    //therefore, the 'mirror' server on the redirect port need only be a 'throw-away' shim that redirects all requests to SSL
                    var redirectServer = Connect(
                      function(req, res, next) {
                        //do the redirect
                        res.statusCode = 302;
                        var host = options.host;
                        var port = options.ssl.clientRedirectPort || options.ssl.port;

                        //if ssl port is non-standard (443), make sure it gets included in the redirect url
                        host += port === 443 ? "" : ":" + port;
                        res.setHeader("Location", "https://" + host + req.url);
                        res.end();
                      }
                    );
                    redirectServer.listen(options.ssl.redirectServerPort);
                  } else if (options.ssl.routes) {
                    //ssl is defined as only _enforced_ for a subset of routes (all routes MAY still use https, but the configured routes MUST use it),
                    //therefore we must create a full mirror server that has logic to force-redirect to ssl for specific routes

                    deferCompletion = true; //indicate final server setup needs to be deferred

                    //get another copy of the middleware stack for the mirror (cannot use shared stack as each server needs its own)
                    middleware.getMiddleware(options, function(err, __middleware, __rest) {
                      //stash the mirror's rest interface
                      cache.setItem("feather-rest-mirror", __rest);

                      //add the SSL route enforcement middleware module at the top of the new stack
                      __middleware.unshift(connectRouter(function(app) {
                        _.each(options.ssl.routes, function(route) {

                          //redirect all http verbs
                          _.each(connectRouter.methods, function(verb) {
                            (app[verb])(new RegExp(route), function(req, res, next) {
                              //do the redirect
                              res.statusCode = 302;
                              var host = options.host;
                              var port = options.ssl.clientRedirectPort || options.ssl.port;
                              //if ssl port is non-standard (443), make sure it gets included in the redirect url
                              host += port === 443 ? "" : ":" + port;
                              res.setHeader("Location", "https://" + host + req.url);
                              res.end();
                            });
                          });
                        });
                      }));

                      //spin up mirror and complete server setup
                      mirror = Connect();
                      _.each(__middleware, function(ware) {
                        mirror.use(ware);
                      });

                      mirror.httpServer = http.createServer(mirror).listen(options.port);

                      completeServerSetup();
                    });
                  }
                }

                if (!deferCompletion) completeServerSetup();
              }
            });
          }

        },
        complete: function() {
          return this.states.complete;
        }
      }, //end createServer state
      complete: {
        stateStartup: function(server, mirror) {
          cb(null, server, mirror);
          fsm.dispose();
        }
      },
      error: {
        stateStartup: function(err) {
          cb(err);
          fsm.dispose();
        }
      }
    }
  });
};