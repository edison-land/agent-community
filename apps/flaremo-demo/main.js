import { runMockDemo } from './scenario.js';
const report = await runMockDemo();
console.log(JSON.stringify(report, null, 2));
if (report.status !== 'passed') process.exitCode = 1;
