var sys = util = require("util"),
  _ = require("underscore")._,
  fs = require("fs"),
  jsdom = require("jsdom"),
  encoder = new (require('./encoder.js'))(),
  EventPublisher = require("./event-publisher"),
  Semaphore = require("./semaphore"),
  ResourcePackager = require("./resource-packager"),
  DomManager = require("./dom").DomManager,
  cache = require("./simple-cache"),
  simpleId = require("./simple-id"),
  Widget = require("./widget");

var clientOptions;
var widgetTagFixRegex = /<(\/*)widget/g;
var optionsTagFixRegex = /<(\/*)options/g;

/**
 * @name Parser
 * @class Provides the file parser for the feather framework.
 */

/**
 * Parses the given file and passes a render function to the callback.
 * @memberOf Parser
 * @param {String} path path to the file to parse
 * @param {Object} options Object containing
 *   <ul class="desc"><li>request: HTTP Request</li>
 *   <li>callback: callback Function taking one parameter, a Function that will render the results of the parse operation</li></ul>
 */
var parseFile = exports.parseFile = function(options, cb) {
  cache.getItems([
    "feather-options",
    "feather-logger",
    "feather-domManager",
    "feather-files"
  ], function(err, cacheItems) {
    if (err) cb(err); else {
      var appOptions = cacheItems["feather-options"],
        logger = cacheItems["feather-logger"],
        domManager = cacheItems["feather-domManager"],
        indexedFiles = cacheItems['feather-files'],
        path = options.path,
        fileMetaData = options.fileMetaData || indexedFiles.featherFiles[path],
        req = options.request;

      if (!clientOptions) {
        clientOptions = JSON.stringify({ //add to this as necessary
          "socket.io": appOptions["socket.io"],
          isSecure: appOptions.ssl && appOptions.ssl.enabled,
          sessionCookie: appOptions.connect.session.key,
          useAjaxForSystem: !!appOptions.useAjaxForSystem //normalize to a boolean even if undefined
        });
      }

      logger.info({message:"Parsing file " + path, category:"feather.parser"});

      fs.readFile(path, "utf-8", function(err, data) {
        if (err) cb(err); else {
          var html = data;

          html = html.replace(/<resources ?\/>/, '<resources></resources>');

          domManager.getResource({html: html}, function(dom) {

            Widget.render({
              dom: dom,
              node: dom.document,
              request: req,
              forceReparse: !!options.forceReparse,
              appOptions: appOptions,
              publicRoot: appOptions.publicRoot
            }, function(err, result) {
              if (err) cb(err); else {

                fileMetaData.widgets = {};
                _.each(result.widgets.items, function(widget) {
                  fileMetaData.widgets[widget.templateFilePath] = true;
                });

                //inject scripts and resources into the dom
                var body = dom.$j("body")[0];

                var scriptStr = [
                  'feather.stateMachine.onceState("loadingComplete", function() {\n',
                    ' feather.appOptions = ' + clientOptions + ";\n",
                    ' feather.stateMachine.fire("ready");\n',
                  '});\n',
                  'feather.stateMachine.onceState("ready", function(){\n',
                    result.scripts.join("\n") + '\n',
                  '});\n'
                ].join('');

                //last thing on the page should be to tell the main stateMachine loading is complete
                scriptStr += "feather.stateMachine.fire('loadingComplete');\n";
                scriptStr = encoder.htmlDecode(scriptStr);

                dom.$j("<clientscript type='text/javascript'>{pageScript}</clientscript>").appendTo(body);

                /**
                 * package the resources required from this render cycle ------------------------------
                 */

                //force proper order... first framework resources and then widget resources
                ResourcePackager.packageFrameworkResources({
                  flushCache: !!options.forceReparse,
                  dom: dom,
                  request: req,
                  appOptions: appOptions
                }, function() {
                  ResourcePackager.packageWidgetResources({
                    flushCache: !!options.forceReparse,
                    widgetClassRegistry: result.widgetClassRegistry,
                    dom: dom,
                    request: req,
                    appOptions: appOptions
                  }, function() {

                    if (! appOptions.onParse || typeof appOptions.onParse !== 'function') {
                      // If the onParse hook isn't being used, stub it out as a pass-through so we don't have to semaphore the hell outta things.
                      appOptions.onParse = function(options, cb) { cb(null); };
                    }

                    appOptions.onParse({
                      file: path,
                      dom: dom,
                      appOptions: appOptions

                    }, function(err) {
                      if (err) {
                        logger.error({ message: "onParse error for ${path}: ${err}", replacements: { path: path, err: err }, category: "feather.parser", exception: err });
                      }

                      //cache resulting html
                      var _html = dom.document.documentElement.outerHTML;
                      _html = _html
                        .replace(/\<\/?resources[^\>]*\>/g, "")
                        .replace(/(\<\/?)clientscript/g, "$1script")
                        .replace("{pageScript}", scriptStr)
                        .replace(/\\n/g, "\n");

                      //final replaces: if sending custom tags to the client, namespace them (required for IE)
                      _html = _html.replace(widgetTagFixRegex, "<$1feather:widget");
                      _html = _html.replace(optionsTagFixRegex, "<$1feather:options");

                      //TODO: find non-invasive way to do this that allows overriding
                      _html = "<!doctype html>\n" + _html;

                      // publish the page content...
                      ResourcePackager.packagePageContent({
                        flushCache: !!options.forceReparse,
                        path: path,
                        html: _html,
                        appOptions: appOptions
                      }, function(err, pagePackageResult) {
                        if (err) console.log(err);
                        //defer cleanup
                        process.nextTick(function() {
                          //unload this request's widget instances from memory (which will also clean up the DOM)
                          for (var i = 0, l = result.widgets.items.length, w; i < l; i++) {
                            w = result.widgets.items[i];
                            w && w.dispose && w.dispose();
                          }
                          //release outer dom resource so other code can get it from the pool
                          domManager.release(dom);
                          logger.debug({category: 'feather.domResourceStats', message: domManager.resourceStats()});
                        });

                        // done with this page, call back out
                        cb(null, pagePackageResult);
                      });
                    });
                  });
                });
              }
            });
          });
        }
      });
    }
  });

};

/*
 * Template used below in .parseWidget
 * @type Array
 */
var widgetTemplate = [
  '<widget id="${id}" path="${path}" class="${cls}">',
    '<options>',
      '{{html options}}',
    '</options>',
  '</widget>'
].join('');



var localId = simpleId();

cache.getItemWait("feather-dom", function(err, dom) {
  if (err) throw err;
  /*
   * Template used below in .parseWidget
   */
  var optionTemplate = dom.$j.template(null, '<option name="${name}" value="${value}" />');
  /*
   * Template used below in .parseWidget
   */
  var instanceScript = dom.$j.template(null, [
    'var widget = new ${widgetName}(options);\\n'
  ].join(''));

  cache.setItem(localId + ":optionTemplate", optionTemplate);
  cache.setItem(localId + ":instanceScript", instanceScript);
});

/**
 * Intended for use via feather-client's feather.Widget.load method (ie. client-side widget loading)
 * @memberOf Parser
 * @param {Object} options
 * @param {Object} cb
 */
var parseWidget = exports.parseWidget = function(options, cb) {
  cache.getItemsWait([
    "feather-options",
    "feather-logger",
    "feather-domManager",
    localId + ":optionTemplate",
    localId + ":instanceScript"
  ], function(err, cacheItems) {
    if (err) cb(err); else {
      var appOptions = cacheItems["feather-options"],
        logger = cacheItems["feather-logger"],
        domManager = cacheItems["feather-domManager"],
        optionTemplate = cacheItems[localId + ":optionTemplate"],
        instanceScript = cacheItems[localId + ":instanceScript"],
        path = options.path,
        req = options.request;

      domManager.getResource({}, function(dom) {
        var document = dom.document,
          $j = dom.$j;

        var body = $j('body')[0],
          cls = '';

        var optionsStr = "";
        if (options.options) {
          for (var p in options.options) {
            if (p === "class") {
              cls = options.options[p];
            } else if (p !== "content") {
              optionsStr += optionTemplate(dom.$j, {
                data: {
                  name: p,
                  value: JSON.stringify(options.options[p])
                }
              }).join("");
            }
          }
        }

        //avoid server side id collisions (be safe)
        var widgetId = options.id || simpleId();
        var safeWidgetId = simpleId() + "___" + widgetId; //3 underscores just to make the replaces below more accurate
        var widgetIdRegex = new RegExp(safeWidgetId, "gm");
        var widgetEl = $j.tmpl(widgetTemplate, {
          id: safeWidgetId,
          path: options.path,
          cls: cls,
          options: optionsStr
        }).appendTo(body);

        //start at the document level and render away
        Widget.render({
          dom: dom,
          node: document,
          request: options.request || {},
          publicRoot: appOptions.publicRoot,
          appOptions: appOptions,
          context: "widget", //tell the renderer that this is only a single widget parse
          getInstanceScript: function(renderOptions) {
            if (renderOptions.node === document) {
              return instanceScript;
            }
            return null;
          }
        }, function(err, result) {
          if (err) {
            //defer cleanup to next tick
            process.nextTick(function() {
              if (result) {
                //unload this request's widget instances from memory (which will also clean up the server's DOM)
                for (var i = 0, l = result.widgets.items.length, w; i < l; i++) {
                  w = result.widgets.items[i];
                  w && w.dispose && w.dispose();
                }
              }

              domManager.release(dom);
              logger.debug({category: 'feather.domResourceStats', message: domManager.resourceStats()});
            });
            cb(err);
          } else {
            var scriptStr = encoder
              .htmlDecode(result.scripts.join("\n"))
              .replace(widgetIdRegex, widgetId)
              .replace(/\\n/g, "");
            scriptStr = "(function(options) {" + scriptStr + "})";

            //convert to html
            var html = $j(body).html();
            html = html
              .replace(widgetIdRegex, widgetId)
              .replace(/\\n/g, "\n");

            var classes = [];
            for (var id in result.widgetClassRegistry.itemCache) {
              //if there is not classDef, this is clientOnly and we want to include the id,
              //otherwise, we only include the id if the classDef's prototype is not serverOnly
              var classDef = result.widgetClassRegistry.itemCache[id].classDef;
              if (!classDef || !classDef.prototype.serverOnly) {
                classes.push(id);
              }
            }
            if (!result.renderers || !result.renderers.length) {
              cb(null, {
                html: html,
                script: scriptStr,
                widgetClasses: classes
              });
            } else {
              var renderOptions = {
                html: html
              };
              var sem = result.renderers.length;
              _.each(result.renderers, function(renderer) {
                renderer(renderOptions, function() {
                  sem--;
                  if (sem == 0) {
                    cb(null, {
                      html: renderOptions.html,
                      script: scriptStr,
                      widgetClasses: classes
                    });
                  }
                });
              });
            }

            //defer cleanup to next tick
            process.nextTick(function() {
              //unload this request's widget instances from memory (which will also clean up the server's DOM)
              for (var i = 0, l = result.widgets.items.length, w; i < l; i++) {
                w = result.widgets.items[i];
                w && w.dispose && w.dispose();
              }

              domManager.release(dom);
              logger.debug({category: 'feather.domResourceStats', message: domManager.resourceStats()});
            });
          }
        });
      });
    }
  });
};
