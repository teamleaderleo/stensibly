import {
  formatResults,
  parseVerifyHostedArgs,
  redactSecrets,
  usage,
  verifyHosted,
} from "./verify-hosted.js";
import { verifyHostedToolContract } from "./verify-hosted-tool-contract.js";

try {
  const parsed = parseVerifyHostedArgs(Bun.argv.slice(2));
  if (parsed.help) {
    console.log(usage());
  } else if (parsed.options) {
    const results = await verifyHosted(parsed.options);
    results.push(await verifyHostedToolContract(parsed.options));
    console.log(formatResults(results));
    if (results.some((result) => !result.ok)) process.exitCode = 1;
  }
} catch (error) {
  console.error(redactSecrets(error));
  process.exitCode = 1;
}
