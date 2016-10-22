import path from 'path';
import _ from 'lodash';
import childProcess from 'child_process';
import spawn from './spawn';
import { preGypFixRun } from './node-pre-gyp-fix';
import { locateElectronPrebuilt } from './electron-locater';

export { preGypFixRun };

const fs = require('fs');

const getHeadersRootDirForVersion = (version) => {
  return path.resolve(__dirname, 'headers');
};

const checkForInstalledHeaders = async function(nodeVersion, headersDir) {
  const canaryNode = path.join(headersDir, '.node-gyp', nodeVersion, 'common.gypi');
  const canaryIoJS = path.join(headersDir, '.node-gyp', `iojs-${nodeVersion}`, 'common.gypi');

  if (!(fs.existsSync(canaryNode) || fs.existsSync(canaryIoJS))) throw new Error("Canary file 'common.gypi' doesn't exist");
  return true;
};

const spawnWithHeadersDir = async (cmd, args, headersDir, cwd, verbose=false) => {
  let env = _.extend({}, process.env, { HOME: headersDir });
  if (process.platform === 'win32')  {
    env.USERPROFILE = env.HOME;
  }

  try {
    let opts = {env};
    if (cwd) {
      opts.cwd = cwd;
    }

    return await spawn({cmd, args, opts}, verbose);
  } catch (e) {
    if (e.stdout) console.log(e.stdout);
    if (e.stderr) console.log(e.stderr);

    throw e;
  }
};

export async function getElectronModuleVersion(pathToElectronExecutable) {
  let args = [ '-e', 'console.log(process.versions.modules)' ]
  let env = {
    ATOM_SHELL_INTERNAL_RUN_AS_NODE: '1',
    ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_NO_ATTACH_CONSOLE: '1'
  };

  let result = await spawn({cmd: pathToElectronExecutable, args, opts: {env}});
  let versionAsString = (result.stdout + result.stderr).replace(/\n/g, '');

  if (!versionAsString.match(/^\d+$/)) {
    throw new Error(`Failed to check Electron's module version number: ${versionAsString}`);
  }

  return versionAsString;
}

export async function installNodeHeaders(nodeVersion, nodeDistUrl=null, headersDir=null, arch=null) {
  headersDir = headersDir || getHeadersRootDirForVersion(nodeVersion);
  let distUrl = nodeDistUrl || 'https://gh-contractor-zcbenz.s3.amazonaws.com/atom-shell/dist';

  try {
    await checkForInstalledHeaders(nodeVersion, headersDir);
    return;
  } catch (e) { }

  let cmd = 'node';
  let args = [
    require.resolve('npm/node_modules/node-gyp/bin/node-gyp'), 'install',
    `--target=${nodeVersion}`,
    `--arch=${arch || process.arch}`,
    `--dist-url=${distUrl}`
  ];

  await spawnWithHeadersDir(cmd, args, headersDir);
}

export async function shouldRebuildNativeModules(pathToElectronExecutable, explicitNodeVersion=null) {
  // Try to load our canary module - if it fails, we know that it's built
  // against a different node module than ours, so we're good
  //
  // NB: Apparently on OS X, this not only fails to be required, it segfaults
  // the process, because lol.
  try {
    let args = ['-e', 'require("nslog")']
    await spawn({cmd: process.execPath, args});

    require('nslog');
  } catch (e) {
    return true;
  }

  // We need to check the native module version of Electron vs ours - if they
  // happen to be the same, we're good
  let version = explicitNodeVersion ||
    (await getElectronModuleVersion(pathToElectronExecutable));

  if (version === process.versions.modules) {
    return false;
  }

  // If we loaded nslog and the versions don't match, we've got to rebuild
  return true;
}

export async function rebuildNativeModules(nodeVersion, nodeModulesPath, whichModule=null, headersDir=null, arch=null, command='rebuild', ignoreDevDeps=false, ignoreOptDeps=false, verbose=false) {
  headersDir = headersDir || getHeadersRootDirForVersion(nodeVersion);
  await checkForInstalledHeaders(nodeVersion, headersDir);

  let cmd = 'node';
  let args = [
    require.resolve('npm/bin/npm-cli'),
    command
  ];

  if (whichModule) {
    args = args.concat(whichModule.split(','));
  }

  if (ignoreDevDeps || ignoreOptDeps) {
    console.log(nodeModulesPath)
    const packageJSON = require(path.resolve(nodeModulesPath, '..', 'package.json'));
    let modules = Object.keys(packageJSON.dependencies);
    if (!ignoreDevDeps) {
      modules = modules.concat(Object.keys(packageJSON.devDependencies))
    }
    if (!ignoreOptDeps) {
      modules = modules.concat(Object.keys(packageJSON.optionalDependencies))
    }
    args = args.concat(modules)
  }

  args.push(
    '--runtime=electron',
    `--target=${nodeVersion}`,
    `--arch=${arch || process.arch}`,
    `--update-binary`
  );

  await spawnWithHeadersDir(cmd, args, headersDir, nodeModulesPath, verbose);
}

export function createPackagerCopyHook(distUrl=null, ignoreDev=false, ignoreOpt=false, preGypFix=false, verbose=false) {
  return (buildPath, electronVersion, platform, arch, callback) => {
    if (process.platform !== platform) return callback(new Error('You can\'t rebuild native modules for a platform that is not your current platform'))
    let electronPath = locateElectronPrebuilt();
    try {
      let pathDotText = path.join(electronPath, 'path.txt');
      electronPath = path.resolve(electronPath, fs.readFileSync(pathDotText, 'utf8'));
    } catch (e) {
      console.error("Couldn't find electron-prebuilt in the temporary packager directory, this probably means something is wrong");
    }
    console.log('Rebuilding native modultes in:', buildPath)

    installNodeHeaders(electronVersion, distUrl, null, arch)
      .then(() => rebuildNativeModules(electronVersion, path.resolve(buildPath, 'node_modules'), null, null, arch, 'rebuild', ignoreDev, ignoreOpt, verbose))
      .then(() => preGypFixRun(path.resolve(buildPath, 'node_modules'), preGypFix, electronPath, null))
      .then(() => {
        console.log('Rebuild completed successfully')
        callback()
      })
      .catch((err) => callback(err));
  }
}
