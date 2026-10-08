// Run in the same environment as the server. Never prints keys or raw provider responses.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadConfiguration} from '../lib/config.mjs';
import {createProvider, ProviderError} from '../lib/provider.mjs';
import {resolveSelection} from '../lib/model-catalog.mjs';

try {
  const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const config=await loadConfiguration({root,args:process.argv.slice(2)});
  if(config.ignoredModelOverrides.length) console.log(`Model environment overrides ignored: ${config.ignoredModelOverrides.join(', ')}. Choose the model in the app.`);
  const provider=createProvider(resolveSelection(config));
  const result=await provider.interpretBrief({brief:'Keep the existing product facts unchanged.',facts:{product:'Connection check',monthlyPrice:1,sharing:false,maxTeammates:0}});
  console.log(JSON.stringify({ok:true,provider:config.provider,model:result.requests[0].model,attempts:result.requests[0].attempts},null,2));
} catch(error) {
  console.error(JSON.stringify(error instanceof ProviderError ? {ok:false,code:error.code,message:error.message,details:error.details} : {ok:false,message:'Configuration could not be loaded. Check the config path and selected provider.'},null,2));
  process.exitCode=1;
}
