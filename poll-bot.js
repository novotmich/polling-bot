// Weekly Poll Discord Bot — Button‑Based Rows
// Author: ChatGPT (OpenAI)
// Enhanced: auto‑rebalance POD slots + nicer ordinal naming (2nd, 3rd …)

import '@dotenvx/dotenvx/config';
import {
  Client,
  GatewayIntentBits,
  Collection,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  REST,
  Routes,
} from 'discord.js';
import cron from 'node-cron';
import process from 'node:process';

const TIMEZONE = 'Europe/Bratislava';
const CRON_SPEC = '0 10 * * 0';
const WEEK_DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const CAP = 4;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const polls = new Collection();

function ordinal(n){const s=["th","st","nd","rd"],v=n%100;return s[(v-20)%10]||s[v]||s[0];}

function buildRows(poll){
  const rows=[];let row=new ActionRowBuilder();
  poll.options.forEach((opt,i)=>{
    const style= opt.locked?ButtonStyle.Secondary: (opt.label.includes('POD')?ButtonStyle.Success:ButtonStyle.Primary);
    const btn=new ButtonBuilder()
      .setCustomId(`vote:${poll.id}:${opt.id}`)
      .setLabel(`${opt.label} (${opt.votes.length}/${CAP})${opt.locked?' 🔒':''}`)
      .setStyle(style);
    row.addComponents(btn);
    if(row.components.length===5||i===poll.options.length-1){rows.push(row);row=new ActionRowBuilder();}
  });
  rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder()
    .setCustomId(`show:${poll.id}`)
    .setLabel('📋 Show Responses')
    .setStyle(ButtonStyle.Secondary)));
  return rows;
}

async function createWeeklyPoll(){
  const channel=await client.channels.fetch(process.env.POLL_CHANNEL_ID).catch(()=>null);
  if(!channel){console.error('Invalid POLL_CHANNEL_ID or no access');return;}
  const pollId=Date.now().toString(36);
  const poll={id:pollId,options:WEEK_DAYS.map(d=>({base:d,label:d,id:`${d}_${Date.now().toString(36)}`,votes:[],locked:false}))};
  const msg=await channel.send({content:`📊 **Weekly Availability Poll**\n———————————————\nWhat day(s) work for you this week @everyone?\n\n✅ Click buttons to vote.\n↩️ Click again to remove vote.\n🔒 Locks at ${CAP} votes and another option for POD will open.`,components:buildRows(poll)});
  polls.set(msg.id,poll);
}

function rebalance(base,poll){
  const original= poll.options.find(o=>o.base===base&& !o.label.includes('POD'));
  const pods = poll.options.filter(o=>o.base===base && o.label.includes('POD'));
  pods.sort((a,b)=> parseInt(a.id.split('_')[1]) - parseInt(b.id.split('_')[1]));
  let changed=false;
  for(const pod of pods){
    while(original.votes.length< CAP && pod.votes.length>0){
      original.votes.push(pod.votes.shift());
      changed=true;
    }
    if(pod.votes.length===0){
      poll.options.splice(poll.options.indexOf(pod),1);
      changed=true;
    }
    if(original.votes.length>=CAP) break;
  }
  original.locked = original.votes.length>=CAP;
  return changed;
}

client.once('ready',()=>{console.log(`✓ Logged in as ${client.user.tag}`);cron.schedule(CRON_SPEC,createWeeklyPoll,{timezone:TIMEZONE});});

client.on('interactionCreate',async interaction=>{
  if(interaction.isChatInputCommand()&&interaction.commandName==='poll'){await createWeeklyPoll();await interaction.reply({content:'✅ Poll posted.',flags:64});return;}
  if(!interaction.isButton())return;
  const [type,pollId,optId]=interaction.customId.split(':');
  const poll=polls.get(interaction.message.id);
  if(!poll||poll.id!==pollId)return;

  if(type==='show'){
    const lines=poll.options.map(o=>`**${o.label}** (${o.votes.length}/${CAP}) → ${o.votes.length?o.votes.map(id=>`<@${id}>`).join(', '):'—'}`);
    await interaction.reply({content:lines.join('\n'),ephemeral:true});return;
  }
  if(type!=='vote')return;
  const option=poll.options.find(o=>o.id===optId);
  if(!option)return;
  const user=interaction.user.id;let uiChanged=false;

  if(option.votes.includes(user)){
    option.votes=option.votes.filter(id=>id!==user);uiChanged=true;
    if(option.locked&&option.votes.length<CAP){option.locked=false;}
    uiChanged = rebalance(option.base,poll)||uiChanged;
  }else{
    if(option.locked){await interaction.reply({content:'That option is full (🔒). Try another POD!',ephemeral:true});return;}
    option.votes.push(user);uiChanged=true;
    if(option.votes.length>=CAP){
      option.locked=true;
      const countSame=poll.options.filter(o=>o.base===option.base).length;
      const suffix=ordinal(countSame);
      poll.options.push({
        base:option.base,
        label:`${option.base} POD ${countSame}${suffix}`,
        id:`${option.base}_${Date.now().toString(36)}`,
        votes:[],
        locked:false
      });
    }
  }
  if(uiChanged){await interaction.update({components:buildRows(poll)});}
});

if(process.argv.includes('--register')){
  const rest=new REST({version:'10'}).setToken(process.env.BOT_TOKEN);
  const cmd=new SlashCommandBuilder().setName('poll').setDescription('Post a new weekly availability poll');
  rest.put(Routes.applicationCommands(process.env.CLIENT_ID),{body:[cmd.toJSON()]})
    .then(()=>{console.log('✓ Slash command /poll registered');process.exit(0);})
    .catch(console.error);
}

client.login(process.env.BOT_TOKEN);
