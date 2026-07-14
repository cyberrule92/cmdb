// Unit tests for the SSH/Linux connector's pure parsers (no SSH server needed).
import assert from 'node:assert';
import {
  parseOsRelease, parseCpuinfo, parseMeminfo, parseLsblk, parseIp, parseDf, classifyOs,
} from '../src/discovery/connectors/ssh.js';

let pass = 0;
const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

const os = parseOsRelease(`NAME="Ubuntu"
VERSION="22.04.4 LTS (Jammy Jellyfish)"
ID=ubuntu
VERSION_ID="22.04"`);
assert.equal(os.os_name, 'Ubuntu');
assert.equal(os.os_id, 'ubuntu');
assert.ok(os.os_version.startsWith('22.04'));
ok('parseOsRelease extracts name/version/id');

assert.equal(classifyOs('VMware ESXi'), 'Hypervisor');
assert.equal(classifyOs('Red Hat Enterprise Linux'), 'Server');
ok('classifyOs distinguishes hypervisor vs server');

const cpu = parseCpuinfo(`processor\t: 0
model name\t: Intel(R) Xeon(R) Gold 6248
processor\t: 1
model name\t: Intel(R) Xeon(R) Gold 6248`);
assert.equal(cpu.cpu_logical, 2);
assert.match(cpu.cpu_model, /Xeon/);
ok('parseCpuinfo counts logical CPUs + model');

assert.equal(parseMeminfo('MemTotal:       263876712 kB\nMemFree: 100 kB').mem_total_gib, 251.7);
ok('parseMeminfo converts to GiB');

const disks = parseLsblk(`sda   894.3G disk SAMSUNG MZ7 S1A2B3
sdb   1.8T   disk SEAGATE ST2 Z9Y8X7
sr0   1024M  rom`);
assert.equal(disks.length, 2, 'only disks (rom filtered)');
assert.equal(disks[0].name, 'sda');
assert.equal(disks[0].serial, 'S1A2B3');
ok('parseLsblk parses disks, filters non-disk');

const nics = parseIp(
  `1: lo: <LOOPBACK> mtu 65536 link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00
2: eno1: <BROADCAST,UP> mtu 1500 link/ether aa:bb:cc:dd:ee:01 brd ff:ff:ff:ff:ff:ff
3: eno2: <BROADCAST,UP> mtu 1500 link/ether aa:bb:cc:dd:ee:02 brd ff:ff:ff:ff:ff:ff`,
  `2: eno1    inet 10.0.0.10/24 brd 10.0.0.255 scope global eno1`);
assert.equal(nics.length, 2, 'loopback excluded');
assert.equal(nics[0].mac, 'aa:bb:cc:dd:ee:01');
assert.deepEqual(nics[0].ipv4, ['10.0.0.10']);
ok('parseIp extracts NICs + MACs + IPv4, skips lo');

const df = parseDf(`Filesystem     Type     1024-blocks     Used Available Capacity Mounted on
/dev/sda1      ext4       102687672 24681234  72793048      26% /
tmpfs          tmpfs        1319384        0   1319384       0% /dev/shm
/dev/sdb1      xfs       1921802240 12345678 190000000       1% /data`);
assert.equal(df.length, 2, 'tmpfs filtered');
assert.equal(df[0].mount, '/');
assert.equal(df[1].fstype, 'xfs');
ok('parseDf parses real filesystems, filters tmpfs');

console.log(`\n${pass} assertions passed.`);
