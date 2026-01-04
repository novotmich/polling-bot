// Weekly Poll Discord Bot — PostgreSQL‑Backed
// Author: ChatGPT (OpenAI)
// Enhanced: auto‑rebalance POD slots + ordinal naming starting at 2nd POD + persistent polls using PostgreSQL + week number and dates

import '@dotenvx/dotenvx/config';
import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  REST,
  Routes,
} from 'discord.js';
import express from 'express';
import cron from 'node-cron';
import process from 'node:process';
import pkg from 'pg';
import { DateTime } from 'luxon';

const { Pool } = pkg;
const TIMEZONE = 'Europe/Bratislava';
const CRON_SPEC = '0 10 * * 0';
const WEEK_DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const CAP = 4;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

function ordinal(n){const s=["th","st","nd","rd"],v=n%100;return `${n}${s[(v-20)%10]||s[v]||s[0]}`;}

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
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`show:${poll.id}`).setLabel('📋 Show Responses').setStyle(ButtonStyle.Secondary)
  ));
  return rows;
}

async function savePoll(msgId, poll){
  await pool.query('INSERT INTO polls (message_id, data) VALUES ($1, $2) ON CONFLICT (message_id) DO UPDATE SET data = $2', [msgId, JSON.stringify(poll)]);
}

async function loadPoll(msgId){
  const res = await pool.query('SELECT data FROM polls WHERE message_id = $1', [msgId]);
  return res.rows.length ? res.rows[0].data : null;
}

function getCurrentWeekDates(days){
  const today = DateTime.now().setZone(TIMEZONE);
  // If today is Sunday (weekday = 7), use next day (Monday)
  const isSunday = today.weekday === 7;
  const monday = isSunday
    ? today.plus({ days: 1 }).set({ weekday: 1 })
    : today.set({ weekday: 1 });

  const weekNumber = monday.weekNumber;

  const mapped = days.map(day => {
    const offset = WEEK_DAYS.indexOf(day);
    const date = monday.plus({ days: offset });
    return {
      base: day,
      label: `${day} (${date.toFormat('d LLL')})`,
      iso: date.toISODate(),
    };
  });

  return { weekNumber, options: mapped };
}

async function createWeeklyPoll(days = WEEK_DAYS){
  const channel = await client.channels.fetch(process.env.POLL_CHANNEL_ID).catch(()=>null);
  if(!channel){console.error('Invalid POLL_CHANNEL_ID or no access');return;}

  // 🧹 Delete old polls before creating a new one
  await pool.query('DELETE FROM polls');

  const { weekNumber, options } = getCurrentWeekDates(days);
  const pollId = Date.now().toString(36);
  const poll = {
    id: pollId,
    options: options.map(d => ({
      base: d.base,
      label: d.label,
      id: `${d.base}_${Date.now().toString(36)}`,
      votes: [],
      locked: false
    }))
  };

  const msg = await channel.send({
    content: `📊 **@everyone Weekly Availability Poll – Week ${weekNumber}**\n———————————————\nWhat day(s) work for you?\n\n✅ Click buttons to vote.\n↩️ Click again to remove vote.\n🔒 Locks at ${CAP} votes and opens another POD.`,
    components: buildRows(poll)
  });

  await savePoll(msg.id, poll);
}

function rebalance(base, poll){
  const original = poll.options.find(o => o.base === base && !o.label.includes('POD'));
  const pods = poll.options.filter(o => o.base === base && o.label.includes('POD'));
  pods.sort((a, b) => a.created - b.created);
  let changed = false;
  for(const pod of pods){
    while(original.votes.length < CAP && pod.votes.length > 0){
      original.votes.push(pod.votes.shift());
      changed = true;
    }
    if(pod.votes.length === 0){
      poll.options.splice(poll.options.indexOf(pod), 1);
      changed = true;
    }
    if(original.votes.length >= CAP) break;
  }
  original.locked = original.votes.length >= CAP;
  return changed;
}

client.once('ready', async () => {
  console.log(`✓ Logged in as ${client.user.tag}`);
  cron.schedule(CRON_SPEC, () => createWeeklyPoll(), { timezone: TIMEZONE });
});

client.on('interactionCreate', async interaction => {
  if(interaction.isChatInputCommand() && interaction.commandName === 'poll'){
    const input = interaction.options.getString('days');
    const selectedDays = input
      ? input.split(',').map(s => s.trim()).filter(d => WEEK_DAYS.includes(d))
      : WEEK_DAYS;
    await createWeeklyPoll(selectedDays);
    await interaction.reply({ content: `✅ Poll posted for: ${selectedDays.join(', ')}`, flags: 64 });
    return;
  }

  if(!interaction.isButton()) return;
  const [type, pollId, optId] = interaction.customId.split(':');
  let poll = await loadPoll(interaction.message.id);
  if(!poll || poll.id !== pollId) return;

  if(type === 'show'){
    const lines = poll.options.map(o =>
      `**${o.label}** (${o.votes.length}/${CAP}) → ${o.votes.length ? o.votes.map(id => `<@${id}>`).join(', ') : '—'}`
    );
    await interaction.reply({ content: lines.join('\n'), ephemeral: true });
    return;
  }

  if(type !== 'vote') return;
  const option = poll.options.find(o => o.id === optId);
  if(!option) return;
  const userId = interaction.user.id;
  let changed = false;

  if(option.votes.includes(userId)){
    option.votes = option.votes.filter(id => id !== userId);
    changed = true;
    if(option.locked && option.votes.length < CAP) option.locked = false;
    changed = rebalance(option.base, poll) || changed;
  } else {
    if(option.locked){
      await interaction.reply({ content: 'That option is full (🔒). Choose another slot!', ephemeral: true });
      return;
    }
    option.votes.push(userId);
    changed = true;
    if(option.votes.length >= CAP){
      option.locked = true;
      const existingPods = poll.options.filter(o => o.base === option.base && o.label.includes('POD')).length;
      const newIndex = existingPods + 2;
      const label = `${option.base} ${ordinal(newIndex)} pod`;
      poll.options.push({
        base: option.base,
        label,
        id: `${option.base}_${Date.now().toString(36)}`,
        votes: [],
        locked: false,
        created: Date.now()
      });
    }
  }

  if(changed){
    await savePoll(interaction.message.id, poll);
    await interaction.update({ components: buildRows(poll) });
  }
});

if(process.argv.includes('--register')){
  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  const cmd = new SlashCommandBuilder()
    .setName('poll')
    .setDescription('Post a new weekly availability poll')
    .addStringOption(opt =>
      opt.setName('days')
        .setDescription('Comma-separated days (e.g., Monday, Wednesday)')
        .setRequired(false)
    );
  rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: [cmd.toJSON()] })
    .then(() => { console.log('✓ Slash command /poll registered'); process.exit(0); })
    .catch(console.error);
}

client.login(process.env.BOT_TOKEN);

// Minimal Express server to prevent Render timeout
const app = express();
app.get('/', (req, res) => res.send('✅ Poll bot is running'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP server listening on port ${PORT}`));
