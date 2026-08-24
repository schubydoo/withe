import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  acknowledgeExposure,
  beyondLoopback,
  bindAddress,
  exposureWarning,
  inContainer,
  suppressionNotice,
  type ContainerProbe,
} from './exposure.ts';

const HOST: ContainerProbe = { markerFile: () => false, cgroup: () => '0::/init.scope\n' };
const DOCKER: ContainerProbe = { markerFile: () => true, cgroup: () => '0::/\n' };
const KUBERNETES: ContainerProbe = {
  // Kubernetes writes no marker file, so only the cgroup line gives it away.
  markerFile: () => false,
  cgroup: () => '0::/kubepods/besteffort/pod3f2b/8a91\n',
};
const BLIND: ContainerProbe = { markerFile: () => false, cgroup: () => null };

test('a container is detected by its marker file or its cgroup', () => {
  assert.equal(inContainer({}, DOCKER), true);
  assert.equal(inContainer({}, KUBERNETES), true);
  assert.equal(inContainer({}, HOST), false);
});

test('an unreadable cgroup is treated as a container', () => {
  // An unreachable dashboard is a worse failure than one bound wider than it
  // needed, and the wider bind is warned about.
  assert.equal(inContainer({}, BLIND), true);
});

test('the operator can settle the question themselves', () => {
  assert.equal(inContainer({ WITHE_IN_CONTAINER: 'true' }, HOST), true);
  assert.equal(inContainer({ WITHE_IN_CONTAINER: '1' }, HOST), true);
  assert.equal(inContainer({ WITHE_IN_CONTAINER: 'false' }, DOCKER), false);
  assert.equal(inContainer({ WITHE_IN_CONTAINER: 'no' }, BLIND), false);
  // An empty value is not an answer.
  assert.equal(inContainer({ WITHE_IN_CONTAINER: '  ' }, HOST), false);
});

test('the bind address follows the deployment, and WITHE_BIND wins over both', () => {
  assert.equal(bindAddress({}, false), '127.0.0.1');
  // A published port cannot reach a loopback-bound process.
  assert.equal(bindAddress({}, true), '0.0.0.0');
  assert.equal(bindAddress({ WITHE_BIND: '0.0.0.0' }, false), '0.0.0.0');
  assert.equal(bindAddress({ WITHE_BIND: '127.0.0.1' }, true), '127.0.0.1');
  assert.equal(bindAddress({ WITHE_BIND: '  ' }, false), '127.0.0.1');
});

test('loopback is recognised in the forms it is written in', () => {
  assert.equal(beyondLoopback('127.0.0.1'), false);
  assert.equal(beyondLoopback('127.1.2.3'), false);
  assert.equal(beyondLoopback('localhost'), false);
  assert.equal(beyondLoopback('::1'), false);
  assert.equal(beyondLoopback('0.0.0.0'), true);
  assert.equal(beyondLoopback('192.168.1.20'), true);
  assert.equal(beyondLoopback('::'), true);
});

test('the warning fires only when reachable and unprotected', () => {
  assert.equal(exposureWarning('127.0.0.1', false), null);
  assert.equal(exposureWarning('0.0.0.0', true), null);

  const warning = exposureWarning('0.0.0.0', false);
  assert.ok(warning);
  // It has to name the risk and both variables that close it, or an operator
  // reads a scary sentence and has nothing to do about it.
  assert.match(warning, /0\.0\.0\.0/);
  assert.match(warning, /read every repository/);
  assert.match(warning, /WITHE_AUTH_USER/);
  assert.match(warning, /WITHE_AUTH_PASS/);
  assert.match(warning, /WITHE_BIND/);
});

test('an acknowledged exposure silences the warning without credentials', () => {
  // The open, unprotected case that would otherwise fire.
  assert.ok(exposureWarning('0.0.0.0', false, false));
  assert.equal(exposureWarning('0.0.0.0', false, true), null);
});

test('the warning never advertises the switch that hides it', () => {
  // Naming WITHE_ACKNOWLEDGE_EXPOSURE in the sentence would turn a security
  // warning into a how-to for ignoring it.
  const warning = exposureWarning('0.0.0.0', false);
  assert.ok(warning);
  assert.doesNotMatch(warning, /ACKNOWLEDGE/);
});

test('the exposure acknowledgement reads the truthy forms', () => {
  assert.equal(acknowledgeExposure({}), false);
  assert.equal(acknowledgeExposure({ WITHE_ACKNOWLEDGE_EXPOSURE: '' }), false);
  assert.equal(acknowledgeExposure({ WITHE_ACKNOWLEDGE_EXPOSURE: 'false' }), false);
  assert.equal(acknowledgeExposure({ WITHE_ACKNOWLEDGE_EXPOSURE: '0' }), false);
  assert.equal(acknowledgeExposure({ WITHE_ACKNOWLEDGE_EXPOSURE: '1' }), true);
  assert.equal(acknowledgeExposure({ WITHE_ACKNOWLEDGE_EXPOSURE: 'true' }), true);
  assert.equal(acknowledgeExposure({ WITHE_ACKNOWLEDGE_EXPOSURE: ' YES ' }), true);
});

test('acknowledging an open bind leaves a startup notice, so it is not invisible', () => {
  const notice = suppressionNotice('0.0.0.0', false, true);
  assert.ok(notice);
  assert.match(notice, /0\.0\.0\.0/);
  assert.match(notice, /no password/);
  assert.match(notice, /WITHE_ACKNOWLEDGE_EXPOSURE/);
});

test('the suppression notice records nothing when nothing was suppressed', () => {
  // Acknowledged but not actually exposed: loopback, or credentials set.
  assert.equal(suppressionNotice('127.0.0.1', false, true), null);
  assert.equal(suppressionNotice('0.0.0.0', true, true), null);
  // Not acknowledged: the real warning fires instead, so no notice here.
  assert.equal(suppressionNotice('0.0.0.0', false, false), null);
});
