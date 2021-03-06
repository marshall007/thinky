var util = require('util');
var Promise = require('bluebird');
var EventEmitter = require('events').EventEmitter;

function isPlainObject(obj) {
    return Object.prototype.toString.call(obj) === '[object Object]';
}
util.isPlainObject = isPlainObject;

// Obviously not a real deep copy...
function deepCopy(value) {
    var result;
    if (value instanceof Buffer) {
        // We do a shallow copy here because buffer could in theory
        // be pretty big
        return new Buffer(value);
    }
    else if (isPlainObject(value) === true) {
        result = {};
        loopKeys(value, function(_value, key) {
            if (_value.hasOwnProperty(key)) {
                result[key] = deepCopy(_value[key]);
            }
        });
        return result;
    }
    else if (Array.isArray(value)) {
        result = []
        for(var i=0; i<value.length; i++) {
            result.push(deepCopy(value[i]));
        }
        return result;
    }
    else {
        return value;
    }
}
util.deepCopy = deepCopy;


function tryCatch(toTry, handleError) {
    try{
        toTry()
    }
    catch(err) {
        handleError(err)
    }
}
util.tryCatch = tryCatch;

function hook(options) {
    // Return a promise if a hook is asynchronous
    // If no hook is asynchronous, `fn` can still be asynchronous,
    // in which case we return a promise or undefined

    var preHooks = options.preHooks;
    if (Array.isArray(preHooks) === false) {
        preHooks = [];
    }
    var postHooks = options.postHooks;
    if (Array.isArray(postHooks) === false) {
        postHooks = [];
    }
    var doc = options.doc; // We need the doc to set the context of the hooks
    var async = options.async || false;
    var fn = options.fn; // The function that we are hook
    var fnArgs = options.fnArgs;

    if (async === true) {
        return new Promise(function(resolve, reject) {
            _asyncHook({
                resolve: resolve,
                reject: reject,
                preHooks: preHooks,
                postHooks: postHooks,
                doc: doc,
                fn: fn,
                fnArgs: fnArgs
            });
        });
    }
    else {
        return _syncHook({
            preHooks: preHooks,
            postHooks: postHooks,
            doc: doc,
            fn: fn,
            fnArgs: fnArgs
        });

    }
}
function _syncHook(args) {
    var preHooks = args.preHooks;
    var postHooks = args.postHooks;
    var fn = args.fn;
    var doc = args.doc;
    var fnArgs = args.fnArgs;

    for(var i=0; i<preHooks.length; i++) {
        preHooks[i].call(doc);
    }
    var result = fn.apply(doc, fnArgs);
    for(var j=0; j<postHooks.length; j++) {
        postHooks[j].call(doc);
    }
    return result;
}
function _asyncHook(args) {
    // One of the hook, or the function is asynchronous, so we will
    // always return a promise
    // We only need to keep track of the result return/resolved for fn

    var preHooks = args.preHooks;
    var postHooks = args.postHooks;
    var fn = args.fn;
    var fnArgs = args.fnArgs;
    var doc = args.doc;
    var resolve = args.resolve;
    var reject = args.reject;
    var args = args.args;

    var result;

    var nextPost = function() {
        if (typeof resolve === "function") {
            resolve(result);
        }
        return result;
    }

    var executeMain = function() {
        result = fn.apply(doc, fnArgs);
        if (result instanceof Promise) {
            return result.then(function(res) {
                result = res;
                executeHooks(0, postHooks, doc, reject, nextPost);
            }).error(reject);
        }
        else {
            return executeHooks(0, postHooks, doc, reject, nextPost);
        }
    }

    var nextPre = function() {
        tryCatch(executeMain, function (err) {
            return reject(err);
        });
    }
    return executeHooks(0, preHooks, doc, reject, nextPre);
}
util.hook = hook;

function executeHooks(hookIndex, hooks, doc, reject, next) {
    if (hookIndex < hooks.length) {
        if (hooks[hookIndex].length === 1) {
            hooks[hookIndex].call(doc, function(err) {
                if (err) return reject(err);
                executeHooks(hookIndex+1, hooks, doc, reject, next)
            });
        }
        else {
            hooks[hookIndex](doc);
            executeHooks(hookIndex+1, hooks, doc, reject, next)
        }
    }
    else {
        next();
    }
}

function loopKeys(obj, fn) {
    if (isPlainObject(obj)) {
        var keys = Object.keys(obj);
        var result;
        for(var i=0; i<keys.length; i++) {
            result = fn(obj, keys[i]);
            if (result === false) return;
        }
    }
}
util.loopKeys = loopKeys;

function changeProto(object, newProto) {
    object.__proto__ = newProto;
}
util.changeProto = changeProto;

function recurse(key, joins, modelTo, all, done) {
    return (util.isPlainObject(modelTo) && modelTo.hasOwnProperty(key))
        || ((all === true) && (done[joins[key].model.getTableName()] !== true))
}
util.recurse = recurse;

function bindEmitter(self) {
    util.loopKeys(EventEmitter.prototype, function(emitter, key) {
        var fn = emitter[key];
        if (typeof fn === 'function') {
            self[key] = function() {
                var args = new Array(arguments.length);
                for(var i = 0; i < arguments.length; i++) {
                    args[i] = arguments[i];
                }
                fn.apply(self, args);
            }
        }
    });
}
util.bindEmitter = bindEmitter;

function mergeOptions(options, newOptions) {
    if (util.isPlainObject(newOptions)) {
        var localOptions = {};
        localOptions.enforce_missing = (newOptions.enforce_missing != null) ? newOptions.enforce_missing : options.enforce_missing;
        localOptions.enforce_type = (newOptions.enforce_type != null) ? newOptions.enforce_type : options.enforce_type;
        localOptions.enforce_extra = (newOptions.enforce_extra != null) ? newOptions.enforce_extra : options.enforce_extra;
        return localOptions;

    }
    else {
        return options;
    }
}
util.mergeOptions = mergeOptions;


module.exports = util;
