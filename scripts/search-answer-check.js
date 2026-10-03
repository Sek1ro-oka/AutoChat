import { loadConfig } from '../src/config.js';
import { Model, usageCost } from '../src/model.js';
import { Store } from '../src/store.js';
import { Bot } from '../src/bot.js';
import { activeProfile, profileSessionKey } from '../src/model-profiles.js';

// Live diagnostic using only a public fixed query, no QQ messages or private history.
const config=loadConfig(), store=new Store(config.databasePath), stages=[];
const key=`diagnostic:search-answer:${Date.now()}`;
let output='';
function tracked(model) {
  return { forProfile:profile=>tracked(model.forProfile(profile)), complete:async(messages,options)=>{
    const result=await model.complete(messages,options); stages.push({search:Boolean(options?.search),result});return result;
  }};
}
try {
  const profile=activeProfile(config,store), effective={...config,...profile};
  const bot=new Bot(config,store,tracked(new Model(config)));
  const text='/搜索 DeepSeek API 官方文档的网址是什么？';
  await bot.handle({user:config.adminId,group:false,text,modelText:text,images:[],key,scope:'diagnostic',
    action:'send_private_msg',target:{}},async(action,params)=>{output=params.message[0].data.text;},()=>true);
  const verified=stages.length===2&&stages[0].result.searchVerified&&stages[1].result.text
    &&output.includes('搜索来源')&&!/^\s*#{1,6}\s|\*\*|```|\[[^\]]+\]\(https?:/m.test(output);
  const costs=stages.map(stage=>usageCost(stage.result.usage,effective));
  console.log(JSON.stringify({verified:Boolean(verified),stages:stages.length,sourceCount:stages[0]?.result.sources?.length??0,
    conservativeCostCny:costs.every(cost=>cost!==null)?costs.reduce((a,b)=>a+b,0)/1e6:null}));
  if(!verified)process.exitCode=1;
} catch {console.error('SEARCH_ANSWER_DIAGNOSTIC_FAILED');process.exitCode=1;}
finally {store.clear(profileSessionKey(key,activeProfile(config,store)));store.close();}
