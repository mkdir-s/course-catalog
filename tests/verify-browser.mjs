/* Real Chromium checks: server rendering, browser mutations and five CORS faults. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const project = fileURLToPath(new URL('..', import.meta.url));
const frontend = process.env.FRONTEND_DIR || project;
const frontendPort = process.env.FRONTEND_PORT || '3000';
const backendPort = process.env.BACKEND_PORT || '8000';
const frontendOrigin = `http://localhost:${frontendPort}`;
const apiOrigin = `http://localhost:${backendPort}`;
const backend = process.env.BACKEND_DIR || path.resolve(project, '../04-backend');
const python = process.env.BACKEND_PYTHON || path.join(backend, '.venv/bin/python');
const output = path.join(frontend, 'verification');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let apiProcess, nextProcess, browser, temp;
const apiLogs = [];
let activeLog;

function launch(command, args, cwd, env = {}) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => {
    child.output += data.toString();
    if (child === apiProcess && activeLog) activeLog.text += data.toString();
  });
  return child;
}

async function waitReady(url, child) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error(child.output);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch { /* Wait until the server accepts connections. */ }
    await pause(200);
  }
  throw new Error('Server did not start: ' + child.output);
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), pause(3000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function startApi(variant = 'working') {
  await stop(apiProcess);
  let source = await fs.readFile(path.join(backend, 'main.py'), 'utf8');
  if (variant === 'no-cors') source = source.replace(/app\.add_middleware\([\s\S]*?\n\)/, '');
  if (variant === 'trailing-slash') source = source.replace('allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:3000").split(","),', `allow_origins=["${frontendOrigin}/"],`);
  if (variant === 'no-methods') source = source.replace('    allow_methods=["*"],\n', '');
  if (variant === 'python-error') source = source.replace('courses[p["offset"] :', 'courses[p["ofset"] :');
  if (variant === 'slow') source = source.replace('def get_course(course_id: str) -> Course:\n', 'def get_course(course_id: str) -> Course:\n    import time\n    time.sleep(1)\n');
  await fs.writeFile(path.join(temp, 'main.py'), source);
  activeLog = { variant, text: '' };
  apiLogs.push(activeLog);
  apiProcess = launch(python, ['-m', 'uvicorn', 'main:app', '--host', '0.0.0.0', '--port', backendPort], temp, { CORS_ORIGINS: frontendOrigin });
  await waitReady(apiOrigin + '/', apiProcess);
}

async function newPage(origin = frontendOrigin, disableCache = false) {
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  if (disableCache) await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  const network = [], consoleMessages = [];
  const entries = new Map();
  cdp.on('Network.requestWillBeSent', (event) => {
    if (!event.request.url.startsWith(apiOrigin + '/')) return;
    const entry = { url: event.request.url, method: event.request.method, requestHeaders: event.request.headers };
    entries.set(event.requestId, entry);
    network.push(entry);
  });
  cdp.on('Network.responseReceived', (event) => {
    const entry = entries.get(event.requestId);
    if (entry) { entry.status = event.response.status; entry.responseHeaders = event.response.headers; }
  });
  cdp.on('Network.loadingFailed', (event) => {
    const entry = entries.get(event.requestId);
    if (entry) { entry.error = event.errorText; if (event.corsErrorStatus) entry.corsError = event.corsErrorStatus; }
  });
  page.on('console', (message) => { if (message.type() === 'error') consoleMessages.push(message.text()); });
  return { context, page, origin, network, consoleMessages };
}

async function textVisible(page, text) {
  await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout: 15000 });
}
async function buttonText(page, expected) {
  await page.waitForFunction((text) => [...document.querySelectorAll('button')].some((button) => button.textContent.trim() === text), expected);
}

async function normal() {
  await startApi();
  const state = await newPage();
  const { page, network } = state;
  await page.goto(state.origin + '/courses');
  await textVisible(page, 'Choose a course');
  assert.equal(await page.locator('main .grid > div').count(), 6);
  assert.equal(await page.locator('main .grid h3').first().innerText(), 'AI/LLM Integration');
  assert.equal(network.length, 0, 'Server Component data must not be fetched by the browser');
  await page.goto(state.origin + '/courses/web-security');
  await buttonText(page, '♥ 21');
  const beforeLike = network.length;
  await page.getByRole('button', { name: 'Like Web Security Essentials' }).click();
  await buttonText(page, '♥ 22');
  await page.getByRole('button', { name: 'Like Web Security Essentials' }).click();
  await buttonText(page, '♥ 23');
  const likes = network.slice(beforeLike).filter((entry) => entry.url.endsWith('/like'));
  assert.equal(likes.filter((entry) => entry.method === 'POST').length, 2);
  assert.equal(likes.filter((entry) => entry.method === 'OPTIONS').length, 0);
  await page.reload();
  await buttonText(page, '♥ 23');
  await page.getByLabel('Your name').fill('A');
  await page.getByRole('button', { name: 'Enroll', exact: true }).click();
  await textVisible(page, 'String should have at least 2 characters');
  const first = network.filter((entry) => entry.url.endsWith('/enrollments'));
  assert.equal(first.filter((entry) => entry.method === 'OPTIONS').length, 1);
  assert.equal(first.find((entry) => entry.method === 'OPTIONS').status, 200);
  assert.equal(first.find((entry) => entry.method === 'POST').status, 422);
  await page.screenshot({ path: path.join(output, 'validation-422.png'), fullPage: true });
  await page.getByLabel('Your name').fill('Aigerim');
  await page.getByRole('button', { name: 'Enroll', exact: true }).click();
  await textVisible(page, 'You are enrolled. Enrollment number: 1');
  assert.equal(network.filter((entry) => entry.method === 'OPTIONS' && entry.url.endsWith('/enrollments')).length, 1, 'Preflight permission should be cached');
  assert.deepEqual(await (await fetch(apiOrigin + '/enrollments')).json(), [{ id: 1, courseId: 'web-security', studentName: 'Aigerim' }]);
  await page.screenshot({ path: path.join(output, 'course-enrolled.png'), fullPage: true });
  const cdp = await state.context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  const optionsBefore = network.filter((entry) => entry.method === 'OPTIONS').length;
  await page.getByRole('button', { name: 'Enroll', exact: true }).click();
  await textVisible(page, 'Enrollment number: 2');
  assert.equal(network.filter((entry) => entry.method === 'OPTIONS').length, optionsBefore + 1);
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: false });
  await page.goto(state.origin + '/courses');
  await page.screenshot({ path: path.join(output, 'courses.png'), fullPage: true });
  await page.goto(state.origin + '/filter');
  await page.locator('main li').nth(5).waitFor();
  assert.equal(await page.locator('main li').count(), 6);
  await page.getByRole('checkbox', { name: 'Electives only' }).check();
  await page.waitForFunction(() => document.querySelectorAll('main li').length === 2);
  assert.match(await page.locator('main').innerText(), /AI\/LLM Integration[\s\S]*API Design/);
  assert.ok(network.some((entry) => entry.url.endsWith('?is_elective=true')));
  await page.screenshot({ path: path.join(output, 'filter-electives.png'), fullPage: true });
  await page.getByRole('checkbox', { name: 'Electives only' }).uncheck();
  await page.waitForFunction(() => document.querySelectorAll('main li').length === 6);
  await page.goto(state.origin + '/courses/does-not-exist');
  await textVisible(page, 'Course not found');
  await state.context.close();
  return { name: 'working', network, console: state.consoleMessages, passed: true };
}

async function fault(variant, origin = frontendOrigin) {
  await startApi(variant === 'foreign-origin' ? 'working' : variant);
  const state = await newPage(origin, true);
  const { page, network } = state;
  await page.goto(origin + '/courses/web-security');
  await buttonText(page, '♥ 21');
  await page.getByRole('button', { name: 'Like Web Security Essentials' }).click();
  if (variant === 'no-methods' || variant === 'python-error') await buttonText(page, '♥ 22');
  else await textVisible(page, 'Failed to like the course');
  const serverLikes = (await (await fetch(apiOrigin + '/courses/web-security')).json()).likes;
  assert.equal(serverLikes, 22, 'A simple POST still changes server state despite a CORS block');
  await page.getByLabel('Your name').fill('Aigerim');
  await page.getByRole('button', { name: 'Enroll', exact: true }).click();
  if (variant === 'python-error') await textVisible(page, 'Enrollment number: 1');
  else await textVisible(page, 'Could not submit the enrollment');
  const enrollmentEvents = network.filter((entry) => entry.url.endsWith('/enrollments'));
  assert.equal(enrollmentEvents.find((entry) => entry.method === 'OPTIONS').status, variant === 'no-cors' ? 405 : variant === 'python-error' ? 200 : 400);
  // Chromium may create a provisional POST row even when preflight blocks sending it.
  assert.equal(enrollmentEvents.filter((entry) => entry.method === 'POST' && entry.status !== undefined).length, variant === 'python-error' ? 1 : 0);
  await page.goto(origin + '/filter');
  if (variant === 'no-methods') await page.locator('main li').nth(5).waitFor();
  else await textVisible(page, 'Failed to load courses');
  await page.screenshot({ path: path.join(output, variant + '.png'), fullPage: true });
  await page.goto(origin + '/courses');
  if (variant === 'python-error') await textVisible(page, 'Something went wrong');
  else await textVisible(page, 'Choose a course');
  const preflight = await fetch(apiOrigin + '/enrollments', {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  });
  const manualPreflight = { status: preflight.status, headers: Object.fromEntries(preflight.headers), body: await preflight.text() };
  await state.context.close();
  return { name: variant, origin, serverLikes, network, console: state.consoleMessages, manualPreflight, passed: true };
}

async function loadingAndRecovery() {
  await startApi('slow');
  const state = await newPage();
  const { page } = state;
  await page.goto(state.origin + '/courses');
  await page.getByRole('link', { name: 'Web Security Essentials', exact: true }).click();
  await textVisible(page, 'Loading course...');
  await page.getByRole('heading', { name: 'Web Security Essentials', exact: true }).waitFor();
  await stop(apiProcess);
  for (const route of ['/courses', '/courses/web-security']) {
    await page.goto(state.origin + route);
    await textVisible(page, 'Something went wrong');
    await startApi();
    await page.getByRole('button', { name: 'Try again' }).click();
    await textVisible(page, route === '/courses' ? 'Choose a course' : 'Web Security Essentials');
    await stop(apiProcess);
  }
  await state.context.close();
  return { name: 'loading-and-retry', passed: true };
}

async function enrollmentsView() {
  await startApi();
  const state = await newPage();
  const { page } = state;
  await page.route(apiOrigin + '/enrollments', async (route) => {
    await pause(800);
    await route.continue();
  }, { times: 1 });
  await page.goto(frontendOrigin + '/enrollments', { waitUntil: 'commit' });
  await textVisible(page, 'Loading enrollments...');
  await textVisible(page, 'No enrollments yet');
  await page.screenshot({ path: path.join(output, 'enrollments-empty.png'), fullPage: true });

  await page.goto(frontendOrigin + '/courses/web-security');
  await page.getByLabel('Your name').fill('A');
  await page.getByRole('button', { name: 'Enroll', exact: true }).click();
  await textVisible(page, 'String should have at least 2 characters');
  const rejectedRecords = await (await fetch(apiOrigin + '/enrollments')).json();
  assert.equal(rejectedRecords.length, 0);
  await page.getByLabel('Your name').fill('Aigerim');
  await page.getByRole('button', { name: 'Enroll', exact: true }).click();
  await textVisible(page, 'Enrollment number: 1');
  await page.getByRole('link', { name: 'View enrollments' }).click();
  await page.getByRole('cell', { name: 'Aigerim', exact: true }).waitFor();
  await textVisible(page, '1 enrollment');
  await page.getByRole('link', { name: 'Web Security Essentials', exact: true }).waitFor();
  await page.reload();
  await page.getByRole('cell', { name: 'Aigerim', exact: true }).waitFor();

  const second = await fetch(apiOrigin + '/enrollments', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ courseId: 'api-design', studentName: 'Dana' }),
  });
  assert.equal(second.status, 201);
  await page.getByRole('cell', { name: 'Dana', exact: true }).waitFor({ timeout: 10000 });
  await textVisible(page, '2 enrollments');
  const third = await fetch(apiOrigin + '/enrollments', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ courseId: 'backend-fastapi', studentName: 'Mira' }),
  });
  assert.equal(third.status, 201);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('cell', { name: 'Mira', exact: true }).waitFor();
  await textVisible(page, '3 enrollments');
  await page.screenshot({ path: path.join(output, 'enrollments.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: path.join(output, 'enrollments-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1365, height: 900 });

  await page.route(apiOrigin + '/enrollments', (route) => route.fulfill({
    status: 500, contentType: 'application/json',
    headers: { 'Access-Control-Allow-Origin': frontendOrigin },
    body: JSON.stringify({ detail: 'Simulated failure' }),
  }));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await textVisible(page, 'Could not load enrollments');
  await page.unroute(apiOrigin + '/enrollments');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('main').getByRole('alert').waitFor({ state: 'hidden' });
  await startApi();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await textVisible(page, 'No enrollments yet');
  await state.context.close();
  return { name: 'enrollments-view', network: state.network, passed: true };
}

(async () => {
  for (const port of [frontendPort, backendPort]) {
    await new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', () => reject(new Error(`Port ${port} is occupied. Stop the existing server or use isolated test ports.`)));
      server.listen(Number(port), '127.0.0.1', () => server.close(resolve));
    });
  }
  await fs.mkdir(output, { recursive: true });
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'lab5-backend-'));
  for (const file of ['data.py', 'models.py']) await fs.copyFile(path.join(backend, file), path.join(temp, file));
  browser = await chromium.launch(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE, headless: true } : { headless: true });
  nextProcess = launch(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '0.0.0.0', '--port', frontendPort], frontend);
  await waitReady(frontendOrigin + '/', nextProcess);
  const results = [];
  try {
    results.push(await normal());
    console.log('PASS: catalog, persistent likes, validation, enrollment, SWR, preflight cache and 404');
    results.push(await enrollmentsView());
    console.log('PASS: enrollment list, empty/loading/error states, form navigation, persistence, refresh and mobile layout');
    for (const variant of ['no-cors', 'trailing-slash', 'no-methods', 'foreign-origin', 'python-error']) {
      results.push(await fault(variant, variant === 'foreign-origin' ? `http://127.0.0.1:${frontendPort}` : undefined));
      console.log('PASS: ' + variant);
    }
    results.push(await loadingAndRecovery());
    console.log('PASS: loading screen and retry after backend restart on both course routes');
  } finally {
    await fs.writeFile(path.join(output, 'browser-results.json'), JSON.stringify({ checkedAt: new Date().toISOString(), chromium: browser.version(), results }, null, 2) + '\n');
    await fs.writeFile(path.join(output, 'backend-experiments.log'), apiLogs.map((log) => `=== ${log.variant} ===\n${log.text}`).join('\n'));
    await fs.writeFile(path.join(output, 'frontend.log'), nextProcess.output);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await stop(apiProcess);
  await stop(nextProcess);
  if (browser) await browser.close();
  if (temp) await fs.rm(temp, { recursive: true, force: true });
});
