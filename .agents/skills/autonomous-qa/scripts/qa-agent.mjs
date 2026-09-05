#!/usr/bin/env node
import { runCli } from "../runtime/qa-agent.mjs";

process.exitCode = await runCli();
