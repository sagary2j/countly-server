'use strict';

const job = require('../parts/jobs/job.js'),
    async = require('async'),
    plugins = require('../../plugins/pluginManager.js'),
    log = require('../utils/log.js')('job:appExpire'),
    crypto = require('crypto');


/** Class for the user mergind job **/
class AppExpireJob extends job.Job {
    /**
     * Run the job
     * @param {Db} db connection
     * @param {done} done callback
     */
    run(db, done) {
        log.d('Removing expired data ...');
        const database = plugins.dbConnection("countly");
        const drillDatabase = plugins.dbConnection("countly_drill");

        /**
         * clear expired data
         * @param {object} app - app db document
         * @param {object} callback - when procssing finished
         **/
        function clearExpiredData(app, callback) {
            // convert day value to second
            const EXPIRE_AFTER = parseInt(plugins.getConfig("api", app.plugins, true).data_retention_period) * 86400;
            const INDEX_NAME = "cd_1";

            let collections = [];
            let events = ["[CLY]_session", "[CLY]_crash", "[CLY]_view", "[CLY]_action", "[CLY]_push_action", "[CLY]_star_rating"];
            let fromPlugins = plugins.getExpireList();

            // predefined drill events
            events.forEach(function(event) {
                collections.push("drill_events" + crypto.createHash('sha1').update(event + app._id).digest('hex'));
            });
            // collection list that exported from plugins
            fromPlugins.forEach(function(collection) {
                collections.push(collection + app._id);
            });

            database.collection("events").findOne({'_id': database.ObjectID(app._id)}, { list: 1 }, function(err, eventData) {
                if (eventData && eventData.list) {
                    for (let i = 0; i < eventData.list.length; i++) {
                        collections.push("drill_events" + crypto.createHash('sha1').update(eventData.list[i] + app._id).digest('hex'));
                    }
                }
                /**
                * Iterate event cleaning process
                * @param {string} collection - target collection name
                * @param {function} next - iteration callback
                * */
                function eventIterator(collection, next) {
                    console.log("processing", collection);
                    drillDatabase.collection(collection).indexes(function(drillIndexErr, indexes) {
                        if (!drillIndexErr && indexes) {
                            let hasIndex = false;
                            let dropIndex = false;
                            for (let j = 0; j < indexes.length; j++) {
                                if (indexes[j].name === INDEX_NAME) {
                                    if (indexes[j].expireAfterSeconds === EXPIRE_AFTER) {
                                        //print("skipping", c)
                                        hasIndex = true;
                                    }
                                    //has index but incorrect expire time, need to be reindexed
                                    else {
                                        dropIndex = true;
                                    }
                                    break;
                                }
                            }
                            if (dropIndex) {
                                console.log("dropping index", collection);
                                drillDatabase.collection(collection).dropIndex(INDEX_NAME, function() {
                                    console.log("creating index", collection);
                                    drillDatabase.collection(collection).createIndex({ "cd": 1 }, { expireAfterSeconds: EXPIRE_AFTER, "background": true }, function() {
                                        next();
                                    });
                                });
                            }
                            else if (!hasIndex) {
                                console.log("creating index", collection);
                                drillDatabase.collection(collection).createIndex({ "cd": 1 }, { expireAfterSeconds: EXPIRE_AFTER, "background": true }, function() {
                                    next();
                                });
                            }
                            else {
                                next();
                            }
                        }
                        else {
                            next();
                        }
                    });
                }
                async.eachSeries(collections, eventIterator, function() {
                    callback();
                });
            });
        }

        database.collection('apps').find({}, { _id: 1 }).toArray(function(appsErr, apps) {
            if (!appsErr && apps && apps.length) {
                async.eachSeries(apps, clearExpiredData, function() {
                    log.d('Clearing data finished ...');
                    database.close();
                    drillDatabase.close();
                    done();
                });
            }
            else {
                done(appsErr);
            }
        });
    }
}

module.exports = AppExpireJob;