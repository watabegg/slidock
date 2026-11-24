#!/usr/bin/env node
import { runProjectCli } from '../project-cli.js';

await runProjectCli(process.argv.slice(2));
