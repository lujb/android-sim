/*
	Launch android apps into the android Simulator from the command line.
	http://github.com/lujb/android-sim
	
	Copyright (c) 2014 by Kingbo Lu

	Permission is hereby granted, free of charge, to any person obtaining a copy
	of this software and associated documentation files (the "Software"), to deal
	in the Software without restriction, including without limitation the rights
	to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
	copies of the Software, and to permit persons to whom the Software is
	furnished to do so, subject to the following conditions:

	The above copyright notice and this permission notice shall be included in
	all copies or substantial portions of the Software.

	THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
	IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
	FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
	AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
	LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
	OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
	THE SOFTWARE.
*/

var $ = require('shelljs'),
	_ = require('underscore'),
	net = require('net');
	fs = require('fs'),
	path = require('path'),
	spawn = require('child_process').spawn,
	colors = require('colors'),
	parser = require('badging_parser');

$.config.silent = true;
var env = {};


// detect Android SDK environment..
_.some($.env['PATH'].split(path.delimiter), function(p){
	detect_sdk(path.join(p, '..'));
});


// if SDK not found, then request user..
if (!env.SDK) {
	// do something here.
}

// detect android SDK path, return true if found.
function detect_sdk(p) {
	p = path.join(p, 'tools');
	var android = path.join(p, 'android');

	if (fs.existsSync(android)) {
		var emulator = path.join(p, 'emulator');
		var zipalign = path.join(p, 'zipalign');
		var adb = path.resolve(path.join(p, '..', 'platform-tools', 'adb'));
		var aapt = path.resolve(path.join(p, '..', 'platform-tools', 'aapt'));
		var build_tools = path.resolve(path.join(p, '..', 'build-tools'));

		env.SDK = path.resolve(path.join(p, '..'));
		env.android = android;
		_.each([emulator, zipalign, adb, aapt], function(p){
			if (fs.existsSync(p)) {
				env[path.basename(p)] = p;
			}
		});

		// detect aapt path
		if (!env.aapt && fs.existsSync(build_tools)) {
			var got = _.map(fs.readdirSync(build_tools), function(p){
					var got = p.match(/\d+\.?\d*/g);
					var aapt = path.join(build_tools, p, 'aapt');
					if (!fs.existsSync(aapt)) aapt = undefined;
					return {
						version: got==null ? 0:parseFloat(got[0]), 
						path: aapt
			}});

			got = _.filter(got, function(c){return c.path!==undefined});

			if (got.length) {
				env.aapt = _.max(got, function(v){return v.version;}).path;
			}
		}

		return true;
	}
	return false;
}

function get_entry(path) {
	var badging = this.apk_badging(path);
	if (badging) {
	    var packageName = badging.package.name;
	    var activityName = badging['launchable-activity'].name;
	    return packageName + '/' + activityName;
	} else {
		error("Can't get badging info from " + path);
		return undefined;
	}
}

function check_cmd() {
	for (var i in arguments) {
		if (!env[arguments[i]]) {
			error('Command:'+arguments[i].blue+' is not found.');
			return false;
		}
	}
	return true;
}

function info(msg) {
	console.log('[INFO] '.green, msg);
}
function warn(msg) {
	console.log('[WARN] '.yellow, msg);
}
function error(msg) {
	console.log('[ERROR] '.red, msg);
}


// list current android devices
module.exports.list_devices = function(option) {
	if (!check_cmd('adb')) return false;
	var o = $.exec(env.adb+' devices').output;
	var on_devices = o.match(/emulator-\d{4}(?=\s*device)/g);
	var off_devices = o.match(/emulator-\d{4}(?=\s*offline)/g);
	return {on:on_devices, off:off_devices};
}

// list all avds
module.exports.list_avds = function(option) {
	if (!check_cmd('android')) return false;
	var $avds = $.exec(env.android + ' list avd').output;
	var avds = [];
	$avds.replace(/Name:\s*([^\s\n]+)\b/g, function(_, name){
		avds.push(name);
	});
	return avds;
}

// start emulator 
module.exports.start_emulator = function(callback, option) {
	if (!check_cmd('android', 'emulator', 'adb')) return false;
	var self = this;
	var avds = self.list_avds();
	if (avds.length==0) {
		// we create?
		warn('No emulator found, we are going to create one');
		info('Creating a default emulator..');
		$.exec('echo no |' + env.android + ' create avd -n android_sim -t 1 -f');
		info('Success');
		do_start('android_sim');
		return true;
	}
	else {
		// start the one
		do_start(avds[0]);
		return true;
	}

	function do_start(avd) {
		var out = fs.openSync('out.log', 'a');
		var err = fs.openSync('out.log', 'a');
		var emulator = spawn(env.emulator, ['-avd', avd], {detached:true, stdio: [ 'ignore', out, err ]});
		emulator.unref();
		info('Starting emulator('+ avd.grey +')..');

		// waiting for emulator booted
		process.stdout.write('=> 1/2 ');
		(function(){
			var devices = self.list_devices();
			if (devices.off === null) {
				process.stdout.write('.');
				setTimeout(arguments.callee, 1000);
			} else {
				process.stdout.write('\n=> 2/2 ');
				(function(){
					var cmd = env.adb + ' -s '+ devices.off[0] +' shell getprop init.svc.bootanim';
					var $status = $.exec(cmd);
					if (/stopped/.test($status.output)) {
						console.log();
						info('Success');
						callback.call(self, devices.off[0]);
					} else {
						process.stdout.write('.');
						setTimeout(arguments.callee, 1000);
					}
				})();
			}
		})();
	}
};

// install apk into running emulator
module.exports.install_apk = function(path, option) {
	if (!check_cmd('adb')) return false;
	// uninstall old package
	var badging = this.apk_badging(path);
	if (badging) {
		var packageName = badging.package.name;
		var uninstall_cmd = env.adb + ' shell pm uninstall ' + packageName
		info('Uninstalling old package..');
		$.exec(uninstall_cmd);
		info('Success');
		info('Installing new package..');
		var install_cmd = env.adb + ' -s ' + option.device +' install ' + path;
		if ($.exec(install_cmd).code !== 0) {
			error('Install apk failed');
			return false;
		}
		info('Success');
		return true;
	} else {
		error("Can't get badging info from "+ path);
		return false;
	}
};

// start apk
module.exports.start_apk = function(path, option) {
	if (!check_cmd('adb')) return false;
	var devices = this.list_devices().on;
	var self = this;
	if (devices == null) {
		this.start_emulator(do_start);
	} else {
		// choose one running devices
		do_start(devices[0]);
	}
	function do_start(device) {
		var installed = false; 
		if (option.install) {
			installed = self.install_apk(path, {device:device});
		} else {
			installed = true;
		}
		if (installed) {
			var entry = get_entry.call(self, path);
			var run_cmd = env.adb + ' -s ' + device + ' shell am start -n ' + entry;
			info('Running apk..')
			if ($.exec(run_cmd).code !== 0) {
				error('Start apk failed');
			} else {
				// try to unlock home screen
				var port = parseInt(device.match(/\d{4}/)[0]);
				var client = net.connect({port:port},
					function(){
					    client.write('event send EV_KEY:KEY_MENU:1 EV_KEY:KEY_MENU:0\n');
					    client.end();
					});
				info('Success')
			}
		} else {
			error('Start apk failed');
		}
	}
};

// extract apk info
module.exports.apk_badging = function(path, option) {
	if (!check_cmd('aapt')) return false;
	var $result = $.exec(env.aapt + ' dump badging ' + path);
	if ($result.code === 0) {
		return parser.parse($result.output);
	}
	return undefined;
}

// signing apk
module.exports.sign = function(apk, keystore, pass, alias) {
	var cmd = 'echo ' + pass + '| jarsigner -verbose -sigalg SHA1withRSA -digestalg SHA1 -keystore '+keystore+' '+apk+' '+alias+' -sigfile CERT';
	if ($.exec(cmd).code !== 0) {
		error('Sign failed, something wrong with `jarsigner`');
		return false;
	}
	return true;
}

// zipalign the apk file
module.exports.zipalign = function(path, output) {
	if (!check_cmd('zipalign')) return false;
	var $result = $.exec(env.zipalign + ' -f 4 ' + path +' ', + outpath);
	if ($result.code === 0) return true;
	else return false;
};	

module.exports.detect_sdk = detect_sdk;
