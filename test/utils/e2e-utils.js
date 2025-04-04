// Utility Packages
const debug = require('@tryghost/debug')('test');
const Promise = require('bluebird');
const _ = require('lodash');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const uuid = require('uuid');
const KnexMigrator = require('knex-migrator');
const knexMigrator = new KnexMigrator();

// Ghost Internals
const config = require('../../core/shared/config');
const boot = require('../../core/boot');
const db = require('../../core/server/data/db');
const models = require('../../core/server/models');
const urlService = require('../../core/server/services/url');
const settingsService = require('../../core/server/services/settings');
const routeSettingsService = require('../../core/server/services/route-settings');
const themeService = require('../../core/server/services/themes');
const limits = require('../../core/server/services/limits');
const customRedirectsService = require('../../core/server/services/redirects');

// Other Test Utilities
const configUtils = require('./configUtils');
const dbUtils = require('./db-utils');
const urlServiceUtils = require('./url-service-utils');
const redirects = require('./redirects');
const context = require('./fixtures/context');

let ghostServer;
let existingData = {};
let totalStartTime = 0;

/**
 * Because we use ObjectID we don't know the ID of fixtures ahead of time
 * This function fetches all of our fixtures and exposes them so that tests can use them
 * @TODO: Optimize this by making it optional / selective
 */
const exposeFixtures = async () => {
    const fixturePromises = {
        roles: models.Role.findAll({columns: ['id']}),
        users: models.User.findAll({columns: ['id', 'email']}),
        tags: models.Tag.findAll({columns: ['id']}),
        apiKeys: models.ApiKey.findAll({withRelated: 'integration'})
    };
    const keys = Object.keys(fixturePromises);
    existingData = {};

    return Promise
        .all(Object.values(fixturePromises))
        .then((results) => {
            for (let i = 0; i < keys.length; i += 1) {
                existingData[keys[i]] = results[i].toJSON(context.internal);
            }
        })
        .catch((err) => {
            console.error('Unable to expose fixtures', err); // eslint-disable-line no-console
            process.exit(1);
        });
};

const prepareContentFolder = (options) => {
    const contentFolderForTests = options.contentFolder;

    /**
     * We never use the root content folder for testing!
     * We use a tmp folder.
     */
    configUtils.set('paths:contentPath', contentFolderForTests);

    fs.ensureDirSync(contentFolderForTests);
    fs.ensureDirSync(path.join(contentFolderForTests, 'data'));
    fs.ensureDirSync(path.join(contentFolderForTests, 'themes'));
    fs.ensureDirSync(path.join(contentFolderForTests, 'images'));
    fs.ensureDirSync(path.join(contentFolderForTests, 'logs'));
    fs.ensureDirSync(path.join(contentFolderForTests, 'adapters'));
    fs.ensureDirSync(path.join(contentFolderForTests, 'settings'));

    if (options.copyThemes) {
        // Copy all themes into the new test content folder. Default active theme is always casper. If you want to use a different theme, you have to set the active theme (e.g. stub)
        fs.copySync(path.join(__dirname, 'fixtures', 'themes'), path.join(contentFolderForTests, 'themes'));
    }

    if (options.redirectsFile) {
        redirects.setupFile(contentFolderForTests, options.redirectsFileExt);
    }

    if (options.copySettings) {
        fs.copySync(path.join(__dirname, 'fixtures', 'settings', 'routes.yaml'), path.join(contentFolderForTests, 'settings', 'routes.yaml'));
    }
};

// CASE: Ghost Server is Running
// In this case we need to reset things so it's as though Ghost just booted:
// - truncate database
// - re-run default fixtures
// - reload affected services
const restartModeGhostStart = async ({frontend}) => {
    debug('Reload Mode');
    // Teardown truncates all tables and also calls urlServiceUtils.reset();
    await dbUtils.teardown();

    // The tables have been truncated, this runs the fixture init task (init file 2) to re-add our default fixtures
    await knexMigrator.init({only: 2});
    debug('init done');

    // Reset the settings cache
    await settingsService.init();
    debug('settings done');

    if (frontend) {
        // Load the frontend-related components
        await routeSettingsService.init();
        await themeService.init();
        debug('frontend done');
    }

    // Reload the URL service & wait for it to be ready again
    // @TODO: why/how is this different to urlService.resetGenerators?
    urlServiceUtils.reset();
    urlServiceUtils.init({urlCache: !frontend});

    if (frontend) {
        await urlServiceUtils.isFinished();
    }

    debug('routes done');

    await customRedirectsService.init();

    // Reload limits service
    limits.init();
};

const bootGhost = async ({backend, frontend}) => {
    ghostServer = await boot({backend, frontend});
};

// CASE: Ghost Server needs Starting
// In this case we need to ensure that Ghost is started cleanly:
// - ensure the DB is reset
// - CASE: If we are in force start mode the server is already running so we
//      - stop the server (if we are in force start mode it will be running)
//      - reload affected services - just settings and not the frontend!?
// - Start Ghost: Uses OLD Boot process
const freshModeGhostStart = async (options) => {
    if (options.forceStart) {
        debug('Forced Restart Mode');
    } else {
        debug('Fresh Start Mode');
    }

    // Reset the DB
    await knexMigrator.reset({force: true});

    // Stop the server (forceStart Mode)
    await stopGhost();

    // Reset the settings cache and disable listeners so they don't get triggered further
    settingsService.shutdown();

    // Do a full database initialisation
    await knexMigrator.init();

    await settingsService.init();

    // Reset the URL service generators
    // @TODO: Prob B: why/how is this different to urlService.reset?
    // @TODO: why would we do this on a fresh boot?!
    urlService.resetGenerators();

    // Actually boot Ghost
    await bootGhost(options);

    // Wait for the URL service to be ready, which happens after bootYou
    if (options.frontend) {
        await urlServiceUtils.isFinished();
    }
};

const startGhost = async (options) => {
    const startTime = Date.now();
    debug('Start Ghost');
    options = _.merge({
        backend: true,
        frontend: true,
        redirectsFile: true,
        redirectsFileExt: '.json',
        forceStart: false,
        copyThemes: true,
        copySettings: true,
        contentFolder: path.join(os.tmpdir(), uuid.v4(), 'ghost-test'),
        subdir: false
    }, options);

    // Ensure we have tmp content folders populated ready for testing
    // @TODO: tidy up the tmp folders after tests
    prepareContentFolder(options);

    if (ghostServer && ghostServer.httpServer && !options.forceStart) {
        await restartModeGhostStart(options);
    } else {
        await freshModeGhostStart(options);
    }

    // Expose fixture data, wrap-up and return
    await exposeFixtures();

    // Reporting
    const totalTime = Date.now() - startTime;
    totalStartTime += totalTime;
    debug(`Started Ghost in ${totalTime / 1000}s`);
    debug(`Accumulated start time is ${totalStartTime / 1000}s`);
    return ghostServer;
};

const stopGhost = async () => {
    if (ghostServer && ghostServer.httpServer) {
        await ghostServer.stop();
        delete require.cache[require.resolve('../../core/app')];
        urlService.resetGenerators();
    }
};

module.exports = {
    startGhost,
    stopGhost,
    getExistingData: () => {
        return existingData;
    }
};
