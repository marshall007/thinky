var util = require(__dirname+'/util.js');
var type = require(__dirname+'/type.js');
var schemaUtil = require(__dirname+'/schema.js');
var Promise = require('bluebird');
var EventEmitter = require('events').EventEmitter;

function Document(model, options) {
    var self = this;

    this.constructor = model;
    this._model = model._getModel();

    // We don't want to store options if they are different
    // than the one provided by the model
    if (util.isPlainObject(options)) {
        this._schemaOptions = {};
        this._schemaOptions.enforce_missing = (options.enforce_missing != null) ? options.enforce_missing : model.getOptions().enforce_missing;
        this._schemaOptions.enforce_extra = (options.enforce_extra != null) ? options.enforce_extra : model.getOptions().enforce_extra;
        this._schemaOptions.enforce_type = (options.enforce_type != null) ? options.enforce_type : model.getOptions().enforce_type;
    }

    // We want a deep copy
    options = options || {};
    this._options = {};
    /*
    this._options.enforce_missing = (options.enforce_missing != null) ? options.enforce_missing : model.getOptions().enforce_missing;
    this._options.enforce_extra = (options.enforce_extra != null) ? options.enforce_extra : model.getOptions().enforce_extra;
    this._options.enforce_type = (options.enforce_type != null) ? options.enforce_type : model.getOptions().enforce_type;
    */
    this._options.timeFormat = (options.timeFormat != null) ? options.timeFormat : model.getOptions().timeFormat;
    this._options.validate = (options.validate != null) ? options.validate : model.getOptions().validate;

    this._saved = options.saved || false;

    // Copy methods from eventEmitter
    util.bindEmitter(self);

    // links to hasOne/hasMany documents
    // We use it to know if some links have been removed/added before saving.
    // Example: { key: doc } or { key: [docs] }
    this._belongsTo = {};
    this._hasOne = {};
    this._hasMany = {};
    // Example: { <linkTableName>: { <valueOfRightKey>: true, ... }, ... }
    this._links = {}

    // Keep reference of any doc having a link pointing to this
    // So we can clean when users do doc.belongsToDoc.delete()
    this._parents = {
        _hasOne: {}, // <tableName>: [{doc, key}]
        _hasMany: {}, // <tableName>: [{doc, key}]
        _belongsTo: {}, // <tableName>: [{doc, key, foreignKey}]
        _belongsLinks: {} // <tableName>: [{doc, key}]
    }

    util.loopKeys(model._listeners, function(listeners, eventKey) {
        for(var j=0; j<listeners[eventKey].length; j++) {
            if (listeners[eventKey][j].once === false) {
                self.addListener(eventKey, listeners[eventKey][j].listener);
            }
            else if (listeners[eventKey][j].once === true) {
                self.once(eventKey, listeners[eventKey][j].listener);
            }
        }
    });

    util.loopKeys(model._methods, function(methods, key) {
        if (self[key] === undefined) {
            self[key] = methods[key];
        }
        else {
            //console.log(self[key]);
            //console.log("A property "+key+" is already defined in the prototype chain. Skipping.");
        }
    });
}

// Called on the instance of the Model
Document.prototype._getOptions = function() {
    return this.__proto__._options;
}
Document.prototype._getSchemaOptions = function() {
    return this.__proto__._schemaOptions;
}

// Return the constructor
Document.prototype.getModel = function() {
    return this.__proto__.constructor;
}

// Return the instance of Model
Document.prototype._getModel = function() {
    return this.__proto__._model;
}


// The fuck is that?
Document.prototype._get = function(key) {
    return this.__proto__[key];
}


Document.prototype._saveVirtual = function() {
    var copy = {};
    var model = this._getModel(); // instance of Model

    // TODO We could do better and copy less things, but things get a bit tricky
    // when virtual fields are nested in arrays.
    // This implementation still allows no overhead if no virtual fields exist,
    // which should be the most common case
    for(var i=0; i<this._getModel().virtualFields.length; i++) {
        var key = this._getModel().virtualFields[i].path[0];
        copy[key] = this[key];
    }
    this.__proto__.virtualValue = util.deepCopy(copy);
}

Document.prototype._getVirtual = function() {
    return this.__proto__.virtualValue;
}

// Generate the virtual values
// This should be called AFTER _generateDefault
Document.prototype.generateVirtualValues = function() {
    var self = this;
    var doc = self;
    var schema = self._getModel()._schema;
    var options = self._getModel().getOptions();

    self._generateVirtualValues(self, schema, self, self._getVirtual());
}

Document.prototype._generateVirtualValues = function(doc, schema, originalDoc, virtual) {
    for(var i=0; i<this._getModel().virtualFields.length; i++) {
        schemaUtil.generateVirtual(this, this._getModel().virtualFields[i], this, virtual);
    }
}

// Generate the default values for all the fields, except virtual ones
// Virtual fields are generated by `Document.prototype.generateVirtualValues`
Document.prototype._generateDefault = function() {
    for(var i=0; i<this._getModel().defaultFields.length; i++) {
        schemaUtil.generateDefault(this, this._getModel().defaultFields[i], this);
    }
    if (this._getModel().virtualFields.length > 0) {
        this.generateVirtualValues();
    }
}

/*
 * Validate the schema
 * 
 * options = {getJoin: true}
 */
Document.prototype.validate = function(options, modelToValidate, validateAll, validatedModel, prefix) {
    modelToValidate = modelToValidate || {};
    validateAll = validateAll || false;
    validatedModel = validatedModel || {};
    prefix = prefix || '';

    var self = this;
    var validatedModelCopy = util.deepCopy(validatedModel);

    //TODO: Can we not always call this?
    var async = self._validateIsAsync(modelToValidate, validateAll, validatedModelCopy);

    return util.hook({
        preHooks: self._getModel()._pre.validate,
        postHooks: self._getModel()._post.validate,
        doc: self,
        async: async,
        fn: self._validateHook,
        fnArgs: [options, modelToValidate, validateAll, validatedModel, prefix]
    })
}

Document.prototype.validateAll = function(options, modelToValidate) {
    var validateAll = (modelToValidate === undefined) ? true: false;
    modelToValidate = modelToValidate || {};

    return this.validate(options, modelToValidate, validateAll, {}, '', true);
}

Document.prototype._validateHook = function(options, modelToValidate, validateAll, validatedModel, prefix) {
    var self = this;
    var promises = [];
    var error;

    var schemaOptions = self._getSchemaOptions();
    if (util.isPlainObject(schemaOptions)) {
        schemaOptions = util.mergeOptions(schemaOptions, options);
    }
    else {
        schemaOptions = options;
    }


    if (typeof self._getModel()._validator === 'function') {
        if (self._getModel()._validator.call(self, self) === false) {
            throw new Error("Document's validator returned `false`.");
        }
    }

    // Validate this document
    self._getModel()._schema.validate(self, prefix, schemaOptions)

    if (util.isPlainObject(modelToValidate) === false) {
        modelToValidate = {};
    }

    var constructor = self.__proto__.constructor;
    validatedModel[constructor.getTableName()] = true;

    // Validate joined documents
    util.loopKeys(self._getModel()._joins, function(joins, key) {
        if (util.recurse(key, joins, modelToValidate, validateAll, validatedModel)) {
            if (((joins[key].type === 'hasOne') || (joins[key].type === 'belongsTo'))) {
                if (util.isPlainObject(self[key])) {
                    if (self[key] instanceof Document === false) {
                        self[key] = new self._getModel()._joins[key].model(self[key]);
                    }
                    // We do not propagate the options of this document, but only those given to validate
                    var promise = self[key].validate(options, modelToValidate[key], validateAll, validatedModel, prefix+'['+key+']');
                    if (promise instanceof Promise) {
                        promises.push(promise);
                        promise = null;
                    }
                }
                else if (self[key] != null) {
                    throw new Error("Joined field "+prefix+"["+key+"] should be `undefined`, `null` or an `Object`")
                }
            }
            else if (((joins[key].type === 'hasMany') || (joins[key].type === 'hasAndBelongsToMany'))) {
                if (Array.isArray(self[key])) {
                    for(var i=0; i<self[key].length; i++) {
                        if (util.isPlainObject(self[key][i])) {
                            if (self[key][i] instanceof Document === false) {
                                self[key][i] = new self._getModel()._joins[key].model(self[key][i]);
                            }
                            promise = self[key][i].validate(options, modelToValidate[key], validateAll, validatedModel, prefix+'['+key+']['+i+']');
                            if (promise instanceof Promise) {
                                promises.push(promise);
                                promise = null;
                            }
                        }
                        else {
                            throw new Error("Joined field "+prefix+"["+key+"]["+i+"] should be `undefined`, `null` or an `Array`")
                        }
                    }
                }
                else if (self[key] != null) {
                    throw new Error("Joined field "+prefix+"["+key+"] should be `undefined`, `null` or an `Array`")
                }
            }
        }
    });
    if (promises.length > 0) {
        return Promise.all(promises);
    }
}

Document.prototype._validateIsAsync = function(modelToValidate, validateAll, validatedModel) {
    var self = this;

    if (self._getModel()._async.validate) {
        return true;
    }
    var async = false;
    util.loopKeys(self._getModel()._joins, function(joins, key) {
        if (util.recurse(key, joins, modelToValidate, validateAll, validatedModel)) {
            if (((joins[key].type === 'hasOne') || (joins[key].type === 'belongsTo'))) {
                if (util.isPlainObject(self[key])) {
                    if (self[key] instanceof Document === false) {
                        self[key] = new self._getModel()._joins[key].model(self[key]);
                    }
                    // We do not propagate the options of this document, but only those given to validate
                    if (self[key]._getModel()._async.validate || self[key]._validateIsAsync(modelToValidate, validateAll, validatedModel)) {
                        async = true;
                        return false;
                    }
                }
            }
            else  if (((joins[key].type === 'hasMany') || (joins[key].type === 'hasAndBelongsToMany'))) {
                if (Array.isArray(self[key])) {
                    for(var i=0; i<self[key].length; i++) {
                        if (util.isPlainObject(self[key][i])) {
                            if (self[key][i] instanceof Document === false) {
                                self[key][i] = new self._getModel()._joins[key].model(self[key][i]);
                            }
                            if (self[key][i]._getModel()._async.validate || self[key][i]._validateIsAsync(modelToValidate, validateAll, validatedModel)) {
                                async = true;
                                return false;
                            }
                        }
                    }
                }
            }
        }
        return false;
    });
    return async;
}

var types = [
    ['string', String],
    ['number', Number],
    ['boolean', Boolean]
]

Document.prototype.save = function(callback) {
    return this._save({}, false, {}, callback);
}
Document.prototype.saveAll = function(docToSave, callback) {
    var saveAll;
    if (typeof docToSave === 'function') {
        callback = docToSave;
        saveAll = true;
        docToSave = {};
    }
    else {
        saveAll = (docToSave === undefined) ? true: false;
        docToSave = docToSave || {};
    }

    return this._save(docToSave, saveAll,{}, callback);
}

Document.prototype._makeSavableCopy = function() {
    var model = this._getModel(); // instance of Model
    var schema = this._getModel()._schema;

    var r = this._getModel()._thinky.r;

    if (this._getModel().needToGenerateFields === true){
        this._generateDefault();
    }

    return this.__makeSavableCopy(this, schema, this._getOptions(), model, r)
}
// __makeSavableCopy
Document.prototype.__makeSavableCopy = function(doc, schema, options, model, r) {
    var localOptions; // can be undefined
    if (schema !== undefined) {
        localOptions = schema._options;
    }
    /*
    if (util.isPlainObject(schema) && (schema._type !== undefined) && (util.isPlainObject(schema.options))) {
        localOptions = {};
        localOptions.enforce_missing = (schema.options.enforce_missing != null) ? schema.options.enforce_missing : options.enforce_missing;
        localOptions.enforce_type = (schema.options.enforce_type != null) ? schema.options.enforce_type : options.enforce_type;
        localOptions.enforce_extra = (schema.options.enforce_extra != null) ? schema.options.enforce_extra : options.enforce_extra;
    }
    else {
        localOptions = options;
    }
    */

    // model is an instance of a Model (for the top level fields), or undefined
    var result, key, keys, nextSchema, copyFlag;
    if (type.isDate(schema) && (typeof doc === 'string')) {
        return new Date(doc); // Use r.ISO8601 and not `new Date()` to keep timezone
    }
    else if (type.isPoint(schema)) {
        if (util.isPlainObject(doc) && (doc['$reql_type$'] !== "GEOMETRY")) {
            var keys = Object.keys(doc).sort();
            if ((keys.length === 2) && (keys[0] === 'latitude') && (keys[1] === 'longitude') && (typeof doc.latitude === "number") && (typeof doc.longitude === "number")) {
                return r.point(doc.longitude, doc.latitude)
            }
            else if ((doc.type === "Point") && (Array.isArray(doc.coordinates)) && (doc.coordinates.length === 2)) { // Geojson
                return r.geojson(doc)
            }
        }
        else if (Array.isArray(doc)) {
            if ((doc.length === 2) && (typeof doc[0] === "number") && (typeof doc[1] === "number")) {
                return r.point(doc[0], doc[1])
            }
        }
    }

    if (util.isPlainObject(doc) && (doc instanceof Buffer === false)) {
        result = {};
        util.loopKeys(doc, function(doc, key) {
            copyFlag = true;
            if ((util.isPlainObject(model) === false) || (model._joins[key] === undefined)) { // We do not copy joined documents
                if ((schema !== undefined) && (type.isVirtual(schema._schema[key]) === true)) {
                    // We do not copy virtual
                }
                else if (((schema === undefined) || (schema._schema[key] === undefined)) && (localOptions !== undefined) && (localOptions.enforce_extra === "remove")) {
                    // We do not copy fields if enfroce_extra is "remove"
                }
                else {
                    if (schema !== undefined) {
                        nextSchema = schema._schema[key];
                    }
                    result[key] = Document.prototype.__makeSavableCopy(doc[key], nextSchema, localOptions, undefined, r);
                }
            }
        });

        // Copy the fields that are used as foreign keys
        if (util.isPlainObject(model) === true) {
            util.loopKeys(model._localKeys, function(localKeys, localKey) {
                if (doc[localKey] !== undefined) {
                    result[localKey] = Document.prototype.__makeSavableCopy(doc[localKey], nextSchema, localOptions, undefined, r);
                }
            });
        }
        return result;
    }
    else if (Array.isArray(doc)) {
        result = [];
        copyFlag = true;

        // Next schema
        if (Array.isArray(schema)) {
            nextSchema = schema[0];
        }
        else if ((util.isPlainObject(schema)) && (schema._type !== undefined) && (schema._schema !== undefined)) {
            nextSchema = schema._schema
            if (schema._type === "virtual") {
                copyFlag = false;
            }
        }
        else {
            nextSchema = undefined;
        }
        if (copyFlag === true) {
            for(var i=0; i<doc.length; i++) {
                result.push(Document.prototype.__makeSavableCopy(doc[i], nextSchema, localOptions, undefined, r));
            }
        }
        return result;
    }
    // else, doc is a primitive (or a buffer)
    return doc;
}


Document.prototype._save = function(docToSave, saveAll, savedModel, callback) {
    //TOIMPROVE? How should we handle circular references outsides of joined fields? Now we throw with a maximum call stack size exceed
    var self = this;
    self.emit('saving', self);

    return util.hook({
        preHooks: self._getModel()._pre.save,
        postHooks: self._getModel()._post.save,
        doc: self,
        async: true,
        fn: self._saveHook,
        fnArgs: [docToSave, saveAll, savedModel, callback]
    });
}
Document.prototype._saveHook = function(docToSave, saveAll, savedModel, callback) {
    var self = this;
    var model = self._getModel(); // instance of Model
    var constructor = self.getModel();
    var r = model._thinky.r;

    if (util.isPlainObject(docToSave) === false) {
        docToSave = {};
    }

    savedModel[constructor.getTableName()] = true;


    var p = new Promise(function(resolve, reject) {
        // Steps:
        // - Save belongsTo
        // - Save this
        // - Save hasOne, hasMany and hasAndBelongsToMany docs
        // - Save links

        // We'll use it to know which `belongsTo` docs were saved
        var belongsToKeysSaved = {};

        var copy = self._makeSavableCopy();
        self._saveVirtual();

        // Save the joined documents via belongsTo first
        var promises = [];
        util.loopKeys(model._joins, function(joins, key) {
            if ((docToSave.hasOwnProperty(key) || (saveAll === true)) &&
                    (joins[key].type === 'belongsTo') && ((saveAll === false) || (savedModel[joins[key].model.getTableName()] !== true))) {

                belongsToKeysSaved[key] = true;
                if (self[key] != null) {
                    savedModel[joins[key].model.getTableName()] = true;
                    if (saveAll === true) {
                        promises.push(self[key]._save({}, true, savedModel))
                    }
                    else {
                        promises.push(self[key]._save(docToSave[joins[key].model.getTableName()], false, savedModel))
                    }
                }
            }
        });

        if (model._tableReady === true) {
            Promise.all(promises).then(function() {
                self._onSavedBelongsTo(copy, docToSave, belongsToKeysSaved, saveAll, savedModel, resolve, reject);
            }).error(reject);
        }
        else {
            model.once('ready', function() {
                Promise.all(promises).then(function() {
                    self._onSavedBelongsTo(copy, docToSave, belongsToKeysSaved, saveAll, savedModel, resolve, reject);
                }).error(reject);
            });
        }
    });
    return p.nodeify(callback);
}

Document.prototype._onSavedBelongsTo = function(copy, docToSave, belongsToKeysSaved, saveAll, savedModel, resolve, reject) {
    var self = this;
    var model = self._getModel();
    var constructor = self.__proto__.constructor;
    var r = this._getModel()._thinky.r;

    util.loopKeys(belongsToKeysSaved, function(joins, key) {
        var joins = model._joins;
        if (self[key] != null) {

            self.__proto__._belongsTo[key] = true;

            // Copy foreign key
            if (self[key][joins[key].rightKey] == null) {
                if (self.hasOwnProperty(joins[key].leftKey)) {
                    delete self[joins[key][joins[key].leftKey]];
                }
                if (copy.hasOwnProperty(joins[key].leftKey)) {
                    delete copy[joins[key][joins[key].leftKey]];
                }
            }
            else {
                self[joins[key].leftKey] = self[key][joins[key].rightKey];
                copy[joins[key].leftKey] = self[key][joins[key].rightKey]; // We need to put it in copy before saving it
            }

            // Save the document that belongs to self[key]
            if (self[key].__proto__._parents._belongsTo[constructor.getTableName()] == null) {
                self[key].__proto__._parents._belongsTo[constructor.getTableName()] = [];
            }
            self[key].__proto__._parents._belongsTo[constructor.getTableName()].push({
                doc: self,
                foreignKey: joins[key].leftKey,
                key: key // foreignDoc
            });
        }
    });
    self._saveSelf(copy, docToSave, belongsToKeysSaved, saveAll, savedModel, resolve, reject)
}

Document.prototype._saveSelf = function(copy, docToSave, belongsToKeysSaved, saveAll, savedModel, resolve, reject) {
    var self = this;
    var model = self._getModel();
    var constructor = self.__proto__.constructor;
    var r = this._getModel()._thinky.r;

    // belongsTo doc were saved before. We just need to copy the foreign key
    util.loopKeys(model._joins, function(joins, key) {
        if ((joins[key].type === 'belongsTo') && (belongsToKeysSaved[key] === true)) {
            if (self[key] != null) {
                self[joins[key].leftKey] = self[key][joins[key].rightKey]
            }
            else if (self.__proto__._belongsTo[key]) {
                delete self[joins[key].leftKey];
                delete copy[joins[key].leftKey];
            }
        }
    });

    var querySaveSelf;
    if (self.__proto__._saved === false) {
        querySaveSelf = r.table(constructor.getTableName()).insert(copy, {returnChanges: true})
    }
    else {
        if (copy[model._pk] === undefined) {
            throw new Error("The document was previously saved, but its primary key is undefined.");
        }
        querySaveSelf = r.table(constructor.getTableName()).get(copy[model._pk]).replace(copy, {returnChanges: true})
    }

    var saveSelfHelper = function() {
        util.tryCatch(function() {
            // Validate the document before saving it
            var promise = self.validate();
            if (promise instanceof Promise) {
                promise.then(function() {
                    querySaveSelf.run().then(function(result) {
                        self._onSaved(result, docToSave, saveAll, savedModel, resolve, reject)
                    }).error(reject)
                }).error(reject);
            }
            else {
                querySaveSelf.run().then(function(result) {
                    self._onSaved(result, docToSave, saveAll, savedModel, resolve, reject)
                }).error(reject)
            }
        }, reject);
    }

    if (self.__proto__._model._tableReady === true) {
        saveSelfHelper();
    }
    else {
        model.once('ready', function() {
            saveSelfHelper();
        })
    }
}
Document.prototype._onSaved = function(result, docToSave, saveAll, savedModel, resolve, reject) {
    var self = this;

    if (result.first_error != null) {
        reject(new Error(result.first_error));
    }
    else {
        util.tryCatch(function() { // Validate the doc, replace it, and tag it as saved
            self._merge(result.changes[0].new_val);

            if (self._getModel().needToGenerateFields === true) {
                self._generateDefault();
            }
            self._setOldValue(util.deepCopy(result.changes[0].old_val));
            self.setSaved();
            self.emit('saved', self);

            var promise = self.validate();
            if (promise instanceof Promise) {
                promise.then(function() {
                    self._saveMany(docToSave, saveAll, savedModel, resolve, reject)
                }).error(reject);
            }
            else {
                self._saveMany(docToSave, saveAll, savedModel, resolve, reject)
            }
        }, reject);
    }
}

Document.prototype._saveMany = function(docToSave, saveAll, savedModel, resolve, reject) {
    var self = this;
    var model = self._getModel();

    var promisesMany = [];
    util.loopKeys(model._joins, function(joins, key) {
        if (((key in docToSave) || (saveAll === true)) &&
                (joins[key].type === 'hasOne') && ((saveAll === false) || (savedModel[joins[key].model.getTableName()] !== true))) {
            savedModel[joins[key].model.getTableName()] = true;

            if (self[key] != null) {
                self[key][joins[key].rightKey] = self[joins[key].leftKey];
                (function(_key) {
                    promisesMany.push(new Promise(function(resolve, reject) {
                        self[_key]._save(docToSave[_key], saveAll, savedModel).then(function() {
                            self.__proto__._hasOne[_key] = {
                                doc: self[_key],
                                foreignKey: self._getModel()._joins[_key].rightKey
                            };
                            if (self[_key].__proto__._parents._hasOne[self._getModel()._name] == null) {
                                self[_key].__proto__._parents._hasOne[self._getModel()._name] = [];
                            }
                            self[_key].__proto__._parents._hasOne[self._getModel()._name].push({
                                doc: self,
                                key: key
                            });
                            resolve();
                        }).error(reject);
                    }))
                })(key)
            }
            else if ((self[key] == null) && (self.__proto__._hasOne[key] != null)) {
                var doc = self.__proto__._hasOne[key].doc;
                delete doc[self.__proto__._hasOne[key].foreignKey];
                promisesMany.push(doc._save(docToSave[key], saveAll, savedModel))
                self.__proto__._hasOne[key] = null;
            }
        }
    });
    util.loopKeys(model._joins, function(joins, key) {
        if (((key in docToSave) || (saveAll === true)) &&
                (joins[key].type === 'hasMany') && ((saveAll === false) || (savedModel[joins[key].model.getTableName()] !== true))
                && (Array.isArray(self[key]))) {

            savedModel[joins[key].model.getTableName()] = true;

            //Go through _hasMany and find element that were removed
            var pkMap = {};
            if (Array.isArray(self[key])) {
                for(var i=0; i<self[key].length; i++) {
                    if (self[key][i][joins[key].model._pk] != null) {
                        pkMap[self[key][i][joins[key].model._pk]] = true;
                    }
                }
            }

            if (self.__proto__._hasMany[key] != null) {
                for(var i=0; i<self.__proto__._hasMany[key].length; i++) {
                    if (pkMap[self.__proto__._hasMany[key][i].doc[[joins[key].model._pk]]] == null) {
                        delete self.__proto__._hasMany[key][i].doc[self.__proto__._hasMany[key][i].foreignKey];
                        promisesMany.push(self.__proto__._hasMany[key][i].doc._save(docToSave[key], saveAll, savedModel));
                    }
                }
            }
            self.__proto__._hasMany[key] = [];
            
            for(var i=0; i<self[key].length; i++) {
                self[key][i][joins[key].rightKey] = self[joins[key].leftKey];
                (function(key, i) {
                    promisesMany.push(new Promise(function(resolve, reject) {
                        self[key][i]._save(docToSave[key], saveAll, savedModel).then(function(doc) {
                            if (!Array.isArray(self.__proto__._hasMany[key])) {
                                self.__proto__._hasMany[key] = [];
                            }
                            self.__proto__._hasMany[key].push({
                                doc: doc,
                                foreignKey: self._getModel()._joins[key].rightKey
                            });

                            if (self[key][i].__proto__._parents._hasMany[self._getModel()._name] == null) {
                                self[key][i].__proto__._parents._hasMany[self._getModel()._name] = [];
                            }
                            self[key][i].__proto__._parents._hasMany[self._getModel()._name].push({
                                doc: self,
                                key: key
                            });

                            resolve();
                        }).error(reject);
                    }))
                })(key, i);
            }
        }
    });
    util.loopKeys(model._joins, function(joins, key) {
        // Compare to null
        if (((key in docToSave) || (saveAll === true)) &&
                (joins[key].type === 'hasAndBelongsToMany') && ((saveAll === false) || (savedModel[joins[key].model.getTableName()] !== true))) {

            savedModel[joins[key].model.getTableName()] = true;

            if (Array.isArray(self[key])) {
                for(var i=0; i<self[key].length; i++) {
                    (function(key, i) {
                        promisesMany.push(new Promise(function(resolve, reject) {
                            self[key][i]._save(docToSave[key], saveAll, savedModel).then(function() {
                                // self.__proto__._links will be saved in saveLinks
                                if (self[key][i].__proto__._parents._belongsLinks[self._getModel()._name] == null) {
                                    self[key][i].__proto__._parents._belongsLinks[self._getModel()._name] = [];
                                }
                                self[key][i].__proto__._parents._belongsLinks[self._getModel()._name].push({
                                    doc: self,
                                    key: key
                                });
                                resolve();
                            }).error(reject);
                        }))
                    })(key, i)
                }
            }
        }
    });

    if (promisesMany.length > 0) {
        Promise.all(promisesMany).then(function() {
            self._saveLinks(docToSave, saveAll, resolve, reject)
        }).error(reject);
    }
    else {
        self._saveLinks(docToSave, saveAll, resolve, reject)
    }
}

Document.prototype._saveLinks = function(docToSave, saveAll, resolve, reject) {
    var self = this;
    var model = self._getModel();
    var constructor = self.getModel();
    var r = model._thinky.r;

    var promisesLink = [];

    util.loopKeys(model._joins, function(joins, key) {
        // Write tests about that!
        if (((key in docToSave) || (saveAll === true)) &&
                (joins[key].type === 'hasAndBelongsToMany')) {

            if (Array.isArray(self[key])) {
                var newKeys = {}
                for(var i=0; i<self[key].length; i++) {
                    if (self[key][i].isSaved() === true) {
                        newKeys[self[key][i][joins[key].rightKey]] = true;
                    }
                }

                if (self.__proto__._links[joins[key].link] === undefined) {
                    self.__proto__._links[joins[key].link] = {}
                }
                var oldKeys = self.__proto__._links[joins[key].link];

                util.loopKeys(newKeys, function(newKeys, link) {
                    if (oldKeys[link] !== true) {
                        var newLink = {};

                        if ((constructor.getTableName() === joins[key].model.getTableName())
                            && (joins[key].leftKey === joins[key].rightKey)) {

                            // We link on the same model and same key
                            // We don't want to save redundant field
                            if (link < self[joins[key].leftKey]) {
                                newLink.id = link+"_"+self[joins[key].leftKey];
                            }
                            else {
                                newLink.id = self[joins[key].leftKey]+"_"+link;
                            }
                            newLink[joins[key].leftKey+"_"+joins[key].leftKey] = [link, self[joins[key].leftKey]];
                        }
                        else {
                            newLink[constructor.getTableName()+"_"+joins[key].leftKey] = self[joins[key].leftKey];
                            newLink[joins[key].model.getTableName()+"_"+joins[key].rightKey] = link;

                            // Create the primary key
                            if (constructor.getTableName() < joins[key].model.getTableName()) {
                                newLink.id = self[joins[key].leftKey]+"_"+link;
                            }
                            else if (constructor.getTableName() > joins[key].model.getTableName()) {
                                newLink.id = link+"_"+self[joins[key].leftKey];
                            }
                            else {
                                if (link < self[joins[key].leftKey]) {
                                    newLink.id = link+"_"+self[joins[key].leftKey];
                                }
                                else {
                                    newLink.id = self[joins[key].leftKey]+"_"+link;
                                }
                            }
                        }
                        
                        (function(key, link) {
                            promisesLink.push(new Promise(function(resolve, reject) {
                                r.table(self._getModel()._joins[key].link).insert(newLink, {conflict: "replace", returnChanges: true}).run().then(function(result) {
                                    self.__proto__._links[joins[key].link][result.changes[0].new_val[joins[key].model.getTableName()+"_"+joins[key].rightKey]] = true;
                                    resolve();
                                }).error(reject);
                            }))
                        })(key, link);
                    }
                });
                self.__proto__._links[joins[key].link] = {};

                var keysToDelete = []
                util.loopKeys(oldKeys, function(oldKeys, link) {
                    if (newKeys[link] === undefined) {
                        if (constructor.getTableName() < joins[key].model.getTableName()) {
                            keysToDelete.push(self[joins[key].leftKey]+"_"+link);
                        }
                        else {
                            keysToDelete.push(link+"_"+self[joins[key].leftKey]);
                        }
                    }
                });
                if (keysToDelete.length > 0) {
                    var table = r.table(joins[key].link);
                    promisesLink.push(table.getAll.apply(table, keysToDelete).delete().run());
                }
            }
        }
    });

    if (promisesLink.length > 0) {
        Promise.all(promisesLink).then(function() {
            resolve(self);
        }).error(reject);
    }
    else {
        resolve(self);
    }
}


Document.prototype.getOldValue = function() {
    return this.__proto__.oldValue;
}
Document.prototype._setOldValue = function(value) {
    return this.__proto__.oldValue = value;
}

Document.prototype.isSaved = function() {
    return this.__proto__._saved;
}
Document.prototype.setSaved = function(all) {
    var self = this;
    self.__proto__._saved = true;
    if (all === true) {
        util.loopKeys(self._getModel()._joins, function(joins, key) {
            if (joins[key].type === 'hasOne') {
                if (self[key] instanceof Document) {
                    self[key].setSaved(true);
                }
            }
            else if (joins[key].type === 'belongsTo') {
                if (self[key] instanceof Document) {
                    self[key].setSaved(true);
                }
            }
            else if (joins[key].type === 'hasMany') {
                if (Array.isArray(self[key])) {
                    for(var i=0; i<self[key].length; i++) {
                        if (self[key][i] instanceof Document) {
                            self[key][i].setSaved(true);
                        }
                    }
                }
            }
            else if (joins[key].type === 'hasAndBelongsToMany') {
                if (Array.isArray(self[key])) {
                    for(var i=0; i<self[key].length; i++) {
                        if (self[key][i] instanceof Document) {
                            self[key][i].setSaved(true);
                        }
                    }
                }
            }
        });
    }
}
Document.prototype._setUnSaved = function() {
    this.__proto__._saved = false;
}


// delete self
// update hasOne docs // remove foreignKey
// nothing to do for belongsto
// update hasMany docs // remove foreignKey
// remove some hasAndBelongsToMany links only if it's a primary key
// TL;DR: Delete self + links/foreign keys if possible
Document.prototype.delete = function(callback) {
    return this._delete({}, false, [], true, callback)
}

// hasOne - belongsTo
// hasMany - belongsTo
// hasAndBelongsToMany

// remove this
// remove hasOne joined doc
// remove belongsTo joined doc if the reverse is a hasOne
// remove hasMany docs
// TL;DR: Delete self + joined documents/links
Document.prototype.deleteAll = function(docToDelete, callback) {
    var deleteAll;
    if (typeof docToDelete === 'function') {
        callback = docToDelete;
        deleteAll = true;
        docToDelete = {};
    }
    else {
        deleteAll = (docToDelete === undefined) ? true: false;
        docToDelete = docToDelete || {};
    }

    return this._delete(docToDelete, deleteAll, [], true, true, callback)
}

// deleteAll, default: false
// deleteSelf, default: true
Document.prototype._delete = function(docToDelete, deleteAll, deletedDocs, deleteSelf, updateParents, callback) {
    //TODO Set a (string) id per document and use it to perform faster lookup
    var self = this;

    if (util.isPlainObject(docToDelete) === false) {
        docToDelete = {};
    }

    deleteSelf = (deleteSelf === undefined) ? true: deleteSelf;

    return util.hook({
        preHooks: self._getModel()._pre.delete,
        postHooks: self._getModel()._post.delete,
        doc: self,
        async: true,
        fn: self._deleteHook,
        fnArgs: [docToDelete, deleteAll, deletedDocs, deleteSelf, updateParents, callback]
    });
}

Document.prototype._deleteHook = function(docToDelete, deleteAll, deletedDocs, deleteSelf, updateParents, callback) {
    var self = this;
    var model = self._getModel(); // instance of Model
    var constructor = self.getModel();
    var r = model._thinky.r;

    var promises = [];

    deletedDocs.push(self);
    util.loopKeys(self._getModel()._joins, function(joins, key) {
        if ((joins[key].type === 'hasOne') && (self[key] instanceof Document)) {
            if ((self[key].isSaved() === true) &&
                ((key in docToDelete) || ((deleteAll === true) && (deletedDocs.indexOf(self[key]) === -1)))) {

                (function(key) {
                    promises.push(new Promise(function(resolve, reject) {
                        self[key]._delete(docToDelete[key], deleteAll, deletedDocs, true, false).then(function() {
                            delete self[key];
                            resolve();
                        }).error(reject);
                    }))
                })(key);
            }
            else if ((deleteSelf === true) && (deletedDocs.indexOf(self[key]) === -1)) {
                delete self[key][joins[key].rightKey];
                if (self[key].isSaved() === true) {
                    promises.push(self[key].save({}, false, {}, true, false));
                }
            }
        }
        if ((joins[key].type === 'belongsTo') && (self[key] instanceof Document)) {
            if ((self[key].isSaved() === true) &&
                ((key in docToDelete) || ((deleteAll === true) && (deletedDocs.indexOf(self[key]) === -1)))) {

                (function(key) {
                    promises.push(new Promise(function(resolve, reject) {
                        self[key]._delete(docToDelete[key], deleteAll, deletedDocs, true, false).then(function() {
                            delete self[key];
                            resolve();
                        }).error(reject);
                    }));
                })(key);
            }
        }

        if ((joins[key].type === 'hasMany') && (Array.isArray(self[key]))) {
            var manyPromises = [];
            for(var i=0; i<self[key].length; i++) {
                if (((self[key][i] instanceof Document) && (self[key][i].isSaved() === true))
                    && ((key in docToDelete) || ((deleteAll === true) && (deletedDocs.indexOf(self[key][i]) === -1)))) {

                    manyPromises.push(self[key][i]._delete(docToDelete[key], deleteAll, deletedDocs, true, false))
                }
                else if ((self[key][i] instanceof Document) && (deletedDocs.indexOf(self[key][i]) === -1)) {
                    delete self[key][i][joins[key].rightKey];
                    if (self[key][i].isSaved() === true) {
                        promises.push(self[key][i].save({}, false, {}, true, false))
                    }
                }
            }
            (function(key) {
                promises.push(new Promise(function(resolve, reject) {
                    Promise.all(manyPromises).then(function() {
                        delete self[key];
                        resolve()
                    })
                }));
            })(key)
        }
        if ((joins[key].type === 'hasAndBelongsToMany') && (Array.isArray(self[key]))) {
            // Delete links + docs
            var pks = []; // primary keys of the documents
            var linksPks = []; // primary keys of the links

            // Store the element we are going to delete.
            // If the user force the deletion of the same element multiple times, we can't naively loop
            // over the elements in the array...
            var docsToDelete = [];


            for(var i=0; i<self[key].length; i++) {
                if (((self[key][i] instanceof Document) && (self[key][i].isSaved() === true))
                    && ((key in docToDelete) || ((deleteAll === true) && (deletedDocs.indexOf(self[key][i]) === -1)))) {

                    //pks.push(self[key][i][joins[key].model._getModel()._pk]);
                    docsToDelete.push(self[key][i]);
                    // We are going to do a range delete, but we still have to recurse 
                    promises.push(self[key][i]._delete(docToDelete[key], deleteAll, deletedDocs, true, false))

                    if (self.getModel()._getModel()._pk === joins[key].leftKey) {
                        // The table is created since we are deleting an element from it
                        if (self._getModel()._name < joins[key].model._getModel()._name) {
                            linksPks.push(self[joins[key].leftKey]+"_"+self[key][i][joins[key].rightKey]);
                        }
                        else {
                            linksPks.push(self[key][i][joins[key].rightKey]+"_"+self[joins[key].leftKey]);
                        }
                    }
                }
                else if ((self[key][i] instanceof Document) && (deletedDocs.indexOf(self[key][i]) === -1)) {
                    // It's safe to destroy links only if it's a primary key
                    if (self.getModel()._getModel()._pk === joins[key].leftKey) {
                        if (self._getModel()._name < joins[key].model._getModel()._name) {
                            linksPks.push(self[joins[key].leftKey]+"_"+self[key][i][joins[key].rightKey]);
                        }
                        else {
                            linksPks.push(self[key][i][joins[key].rightKey]+"_"+self[joins[key].leftKey]);
                        }
                    }
                }
            }
            if (linksPks.length > 0) {
                var query = r.table(joins[key].link);
                query = query.getAll.apply(query, linksPks).delete();
                promises.push(query.run());
            }
        }
    });
    if (updateParents !== false) {
        // Clean links that we are aware of
        util.loopKeys(self.__proto__._parents._hasOne, function(hasOne, key) {
            var parents = hasOne[key];
            for(var i=0; i<parents.length; i++) {
                delete parents[i].doc[parents[i].key];
            }
        });
        util.loopKeys(self.__proto__._parents._belongsTo, function(belongsTo, key) {
            var parents = belongsTo[key];
            for(var i=0; i<parents.length; i++) {
                delete parents[i].doc[parents[i].key];
                delete parents[i].doc[parents[i].foreignKey];
                if (deletedDocs.indexOf(parents[i]) === -1) {
                    promises.push(parents[i].doc.save());
                }
            }
        });
        util.loopKeys(self.__proto__._parents._hasMany, function(hasMany, key) {
            var parents = hasMany[key];
            for(var i=0; i<parents.length; i++) {
                for(var j=0; j<parents[i].doc[parents[i].key].length; j++) {
                    if (parents[i].doc[parents[i].key][j] === self) {
                        parents[i].doc[parents[i].key].splice(j, 1);
                        break;
                    }
                }
            }
        });
        util.loopKeys(self.__proto__._parents._belongsLinks, function(belongsLinks, key) {
            var parents = belongsLinks[key];
            for(var i=0; i<parents.length; i++) {
                for(var j=0; j<parents[i].doc[parents[i].key].length; j++) {
                    if (parents[i].doc[parents[i].key][j] === self) {
                        parents[i].doc[parents[i].key].splice(j, 1);
                        break;
                    }
                }
            }
        });
    }

    if (deleteSelf !== false) {
        if (self.isSaved() === true) {
            promises.push(new Promise(function(resolve, reject) {
                r.table(model._name).get(self[model._pk]).delete().run().then(function(result) {
                    self._setUnSaved();
                    self.emit('deleted', self);
                    resolve(self);
                }).error(reject);
            }))
        }
        // else we don't throw an error, should we?
    }

    var p = new Promise(function(resolve, reject) {
        Promise.all(promises).then(function(result) {
            resolve(self);
        }).error(function(error) {
            reject(error) 
        });
    })
    return p.nodeify(callback);
}

// Delete the references to self in the parents we know
// Clean the database
Document.prototype.purge = function(callback) {
    var self = this;

    var model = self._getModel(); // instance of Model
    var r = model._thinky.r;

    // Clean parent for hasOne
    // doc.otherDoc.delete()
    util.loopKeys(self.__proto__._parents._hasOne, function(hasOne, key) {
        for(var i=0; i<hasOne[key].length; i++) {
            var parentDoc = hasOne[key][i].doc; // A doc that belongs to otherDoc (aka this)
            delete parentDoc[hasOne[key][i].key] // Delete reference to otherDoc (aka this)
        }
    });

    // Clean parent for belongsTo
    // doc.otherDoc.delete()
    util.loopKeys(self.__proto__._parents._belongsTo, function(belongsTo, key) {
        for(var i=0; i<belongsTo[key].length; i++) {
            var parentDoc = belongsTo[key][i].doc;
            delete parentDoc[belongsTo[key][i].key];
            delete parentDoc[belongsTo[key][i].foreignKey];
        }
    });

    // Clean parent for hasMany
    util.loopKeys(self.__proto__._parents._hasMany, function(hasMany, key) {
        for(var i=0; i<hasMany[key].length; i++) {
            var parentDoc = hasMany[key][i].doc; // A doc that belongs to otherDoc (aka this)
            delete parentDoc[hasMany[key][i].key] // Delete reference to otherDoc (aka this)
        }
    });


    // Clean parent for hasAndBelongsToMany
    util.loopKeys(self.__proto__._parents._belongsLinks, function(belongsLinks, key) {
        for(var i=0; i<belongsLinks[key].length; i++) {
            var parentDoc = belongsLinks[key][i].doc;
            var field = belongsLinks[key][i].key;
            for(var j =0; j< parentDoc[field].length; j++) {
                if (parentDoc[field][j] === this) {
                    parentDoc[field].splice(j, 1);
                    break;
                }
            }
        }
    });

    // Purge the database
    var promises = [];
    util.loopKeys(self._getModel()._joins, function(joins, field) {
        var join = joins[field];
        var joinedModel = join.model;

        if ((join.type === 'hasOne') || (join.type === 'hasMany')) {
            promises.push(r.table(joinedModel.getTableName()).getAll(self[join.leftKey], {index: join.rightKey}).replace(function(doc) {
                return doc.without(join.rightKey)
            }).run())
        }
        // nothing to do for "belongsTo"
        else if (join.type === 'hasAndBelongsToMany') {
            if (self.getModel()._getModel()._pk === join.leftKey) {
                // [1]
                promises.push(r.table(join.link).getAll(self[join.leftKey], {index: self.getModel().getTableName()+"_"+join.leftKey}).delete().run())
            }
        }
    });

    util.loopKeys(self._getModel()._reverseJoins, function(reverseJoins, field) {
        var join = reverseJoins[field];
        var joinedModel = join.model; // model where belongsTo/hasAndBelongsToMany was called

        if (join.type === 'belongsTo') {
            // What was called is joinedModel.belongsTo(self, fieldDoc, leftKey, rightKey)
            promises.push(r.table(joinedModel.getTableName()).getAll(self[join.rightKey], {index: join.leftKey}).replace(function(doc) {
                return doc.without(join.leftKey)
            }).run())
        }
        // nothing to do for "belongsTo"
        else if (join.type === 'hasAndBelongsToMany') {
            // Purge only if the key is a primary key
            // What was called is joinedModel.hasAndBelongsToMany(self, fieldDoc, leftKey, rightKey)
            if (self.getModel()._getModel()._pk === join.leftKey) {
                promises.push(r.table(join.link).getAll(self[join.rightKey], {index: self.getModel().getTableName()+"_"+join.rightKey}).delete().run())
            }
        }
    });

    // Delete itself
    promises.push(self.delete())

    return new Promise(function(resolve, reject) {
        Promise.all(promises).then(function() {
            resolve(self);
        }).error(reject);
    }).nodeify(callback);
}

// Behave like `replace`
Document.prototype._merge = function(obj) {
    var self = this;
    util.loopKeys(self, function(self, key) {
        if ((obj[key] === undefined) && (self._getModel()._joins[key] === undefined)) {
            delete self[key];
        }
    });
    util.loopKeys(obj, function(obj, key) {
        self[key] = obj[key];
    });
    return self;
}

Document.prototype.merge = function(obj) {
    var self = this;
    util.loopKeys(obj, function(obj, key) {
        // Recursively merge only if both fields are objects, else we'll overwrite the field
        if (util.isPlainObject(obj[key]) && util.isPlainObject(self[key])) {
            Document.prototype.merge.call(self[key], obj[key])
        }
        else {
            self[key] = obj[key];
        }
    });
    return self;
}

module.exports = Document;
