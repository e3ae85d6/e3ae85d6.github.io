/**
 * Created by dmit8914 on 2017-02-03.
 */

BA.Class.ClusterFeatureLayer = L.esri.FeatureManager.extend({

    statics: {
        EVENTS: 'click dblclick mouseover mouseout mousemove contextmenu popupopen popupclose',
        CLUSTEREVENTS: 'clusterclick clusterdblclick clustermouseover clustermouseout clustermousemove clustercontextmenu'
    },

    /**
     * Constructor
     */

    initialize: function (options) {
        L.esri.FeatureManager.prototype.initialize.call(this, options);

        options = L.setOptions(this, options);

        this._layers = {};
        this._leafletIds = {};

        this.cluster = L.markerClusterGroup(options);
        this._key = 'c' + (Math.random() * 1e9).toString(36).replace('.', '_');

        this.cluster.addEventParent(this);
    },

    /**
     * Layer Interface
     */

    onAdd: function (map) {
        L.esri.FeatureManager.prototype.onAdd.call(this, map);

        this.service.metadata(function (err, metadata) {
            if (!err) {
                this._objectIdField = metadata.objectIdField;
            }
        }, this);

        this._map.addLayer(this.cluster);
    },

    onRemove: function (map) {
        L.esri.FeatureManager.prototype.onRemove.call(this, map);
        this._map.removeLayer(this.cluster);
    },

    /**
     * Feature Management Methods
     */

    createLayers: function (features) {
        var markers = [];

        for (var i = features.length - 1; i >= 0; i--) {
            var geojson = features[i];
            var layer = this._layers[geojson.id];

            if (!layer) {
                var newLayer = L.GeoJSON.geometryToLayer(geojson, this.options);
                newLayer.feature = L.GeoJSON.asFeature(geojson);
                newLayer.defaultOptions = newLayer.options;
                newLayer._leaflet_id = this._key + '_' + geojson.id;

                this.resetStyle(newLayer.feature.id);

                // cache the layer
                this._layers[newLayer.feature.id] = newLayer;

                this._leafletIds[newLayer._leaflet_id] = geojson.id;

                if (this.options.onEachFeature) {
                    this.options.onEachFeature(newLayer.feature, newLayer);
                }

                this.fire('createfeature', {
                    feature: newLayer.feature
                });

                // add the layer if it is within the time bounds or our layer is not time enabled
                if (!this.options.timeField || (this.options.timeField && this._featureWithinTimeRange(geojson))) {
                    markers.push(newLayer);
                }
            }
        }

        if (markers.length) {
            this.cluster.addLayers(markers);
        }
    },

    addLayers: function (ids) {
        var layersToAdd = [];
        for (var i = ids.length - 1; i >= 0; i--) {
            var layer = this._layers[ids[i]];
            this.fire('addfeature', {
                feature: layer.feature
            });
            layersToAdd.push(layer);
        }
        this.cluster.addLayers(layersToAdd);
    },

    removeLayers: function (ids, permanent) {
        var layersToRemove = [];
        for (var i = ids.length - 1; i >= 0; i--) {
            var id = ids[i];
            var layer = this._layers[id];
            this.fire('removefeature', {
                feature: layer.feature,
                permanent: permanent
            });
            layersToRemove.push(layer);
            if (this._layers[id] && permanent) {
                delete this._layers[id];
            }
        }
        this.cluster.removeLayers(layersToRemove);
    },

    /**
     * Styling Methods
     */

    resetStyle: function (id) {
        var layer = this._layers[id];

        if (layer) {
            layer.options = layer.defaultOptions;
            this.setFeatureStyle(layer.feature.id, this.options.style);
        }

        return this;
    },

    setStyle: function (style) {
        this.eachFeature(function (layer) {
            this.setFeatureStyle(layer.feature.id, style);
        }, this);
        return this;
    },

    setFeatureStyle: function (id, style) {
        var layer = this._layers[id];

        if (typeof style === 'function') {
            style = style(layer.feature);
        }
        if (layer.setStyle) {
            layer.setStyle(style);
        }
    },

    /**
     * Utility Methods
     */

    eachFeature: function (fn, context) {
        for (var i in this._layers) {
            fn.call(context, this._layers[i]);
        }
        return this;
    },

    getFeature: function (id) {
        return this._layers[id];
    },



    /**
     * L.esri.FeatureManager Overrides
     */

    _requestFeatures: function (bounds, coords, callback, lastObjectId) {
        this._activeRequests++;

        // our first active request fires loading
        if (this._activeRequests === 1) {
            this.fire('loading', {
                bounds: bounds
            }, true);
        }

        return this._buildQuery(bounds, lastObjectId).run(function (error, featureCollection, response) {
            if (response && response.properties && response.properties.exceededTransferLimit) {

                var lastFeature =
                    response.features &&
                    response.features.length &&
                    response.features[response.features.length - 1];

                var lastOid =
                    lastFeature &&
                    this._objectIdField &&
                    lastFeature.properties &&
                    lastFeature.properties[this._objectIdField];

                if (lastOid)
                    this._requestFeatures(bounds, coords, callback, lastOid);

                this.fire('drawlimitexceeded');
            }

            // no error, features
            if (!error && featureCollection && featureCollection.features.length) {
                // schedule adding features until the next animation frame
                L.Util.requestAnimFrame(L.Util.bind(function () {
                    this._addFeatures(featureCollection.features, coords);
                    this._postProcessFeatures(bounds);
                }, this));
            }

            // no error, no features
            if (!error && featureCollection && !featureCollection.features.length) {
                this._postProcessFeatures(bounds);
            }

            if (error) {
                this._postProcessFeatures(bounds);
            }

            if (callback) {
                callback.call(this, error, featureCollection);
            }
        }, this);
    },

    _buildQuery: function (bounds, lastObjectId) {
        var query = this.service.query()
            .intersects(bounds)
            .fields(this.options.fields)
            .precision(this.options.precision);

        if (this._objectIdField) {
            query.orderBy(this._objectIdField);
        }

        var whereClause;

        if (lastObjectId && this._objectIdField) {
            whereClause = '(' + this.options.where + ') AND (' + this._objectIdField + ' > ' + lastObjectId + ')';
        }
        else {
            whereClause = this.options.where;
        }

        query.where(whereClause);

        if (this.options.simplifyFactor) {
            query.simplify(this._map, this.options.simplifyFactor);
        }

        if (this.options.timeFilterMode === 'server' && this.options.from && this.options.to) {
            query.between(this.options.from, this.options.to);
        }

        return query;
    }
});
