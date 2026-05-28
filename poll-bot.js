// Weekly Poll Discord Bot — PostgreSQL‑Backed
// Author: ChatGPT (OpenAI)
// Enhanced: auto‑rebalance POD slots + ordinal naming starting at 2nd POD + persistent polls using PostgreSQL + week number and dates

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
import https from 'https';

const { Pool } = pkg;
const TIMEZONE = 'Europe/Bratislava';
const CRON_SPEC = '0 10 * * 0';
const WEEK_DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const CAP = 4;
const ADMIN_USER_ID = process.env.ADMIN_USER_ID;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL, 
  ssl: { rejectUnauthorized: false },
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on('error', (err) => {
  console.error('PostgreSQL pool error (non-fatal):', err.message);
});

function isAdmin(interaction){
  if(!ADMIN_USER_ID){
    console.warn('ADMIN_USER_ID not set — admin commands are unrestricted!');
    return true;
  }
  return interaction.user.id === ADMIN_USER_ID;
}

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

async function getActivePoll(){
  const res = await pool.query('SELECT message_id, data FROM polls LIMIT 1');
  return res.rows.length ? { msgId: res.rows[0].message_id, poll: res.rows[0].data } : null;
}

function getCurrentWeekDates(days){
  const today = DateTime.now().setZone(TIMEZONE);
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
  const original = poll.options.find(o => o.base === base && !o.label.toLowerCase().includes('pod'));
  const pods = poll.options.filter(o => o.base === base && o.label.toLowerCase().includes('pod'));
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

  // /poll command — admin only
  if(interaction.isChatInputCommand() && interaction.commandName === 'poll'){
    if(!isAdmin(interaction)){
      await interaction.reply({ content: '❌ You do not have permission to use this command.', flags: 64 });
      return;
    }
    const input = interaction.options.getString('days');
    const selectedDays = input
      ? input.split(',').map(s => s.trim()).filter(d => WEEK_DAYS.includes(d))
      : WEEK_DAYS;
    await createWeeklyPoll(selectedDays);
    await interaction.reply({ content: `✅ Poll posted for: ${selectedDays.join(', ')}`, flags: 64 });
    return;
  }

  // /removepod command — admin only
  if(interaction.isChatInputCommand() && interaction.commandName === 'removepod'){
    if(!isAdmin(interaction)){
      await interaction.reply({ content: '❌ You do not have permission to use this command.', flags: 64 });
      return;
    }

    const active = await getActivePoll();
    if(!active){
      await interaction.reply({ content: '❌ No active poll found.', flags: 64 });
      return;
    }

    const { msgId, poll } = active;
    const pods = poll.options
      .map((o, i) => ({ ...o, _index: i }))
      .filter(o => o.label.toLowerCase().includes('pod'));

    if(pods.length === 0){
      await interaction.reply({ content: '❌ There are no extra pods to remove.', flags: 64 });
      return;
    }

    const podNumber = interaction.options.getInteger('number');

    // No number provided — list available pods
    if(podNumber === null){
      const list = pods.map((p, i) =>
        `**${i + 1}.** ${p.label} — ${p.votes.length} vote(s)${p.locked ? ' 🔒' : ''}`
      ).join('\n');
      await interaction.reply({
        content: `📋 **Current extra pods:**\n${list}\n\nUse \`/removepod number:<n>\` to remove one, or \`/clearpods\` to remove all.`,
        flags: 64
      });
      return;
    }

    if(podNumber < 1 || podNumber > pods.length){
      await interaction.reply({ content: `❌ Invalid number. Choose between 1 and ${pods.length}.`, flags: 64 });
      return;
    }

    const podToRemove = pods[podNumber - 1];
    poll.options.splice(podToRemove._index, 1);
    await savePoll(msgId, poll);

    try {
      const channel = await client.channels.fetch(process.env.POLL_CHANNEL_ID);
      const msg = await channel.messages.fetch(msgId);
      await msg.edit({ components: buildRows(poll) });
    } catch(e) {
      console.error('Could not update poll message:', e.message);
    }

    await interaction.reply({
      content: `✅ Removed pod: **${podToRemove.label}**${podToRemove.votes.length > 0 ? ` (${podToRemove.votes.length} vote(s) removed)` : ''}`,
      flags: 64
    });
    return;
  }

  // /clearpods command — admin only, removes all pods
  if(interaction.isChatInputCommand() && interaction.commandName === 'clearpods'){
    if(!isAdmin(interaction)){
      await interaction.reply({ content: '❌ You do not have permission to use this command.', flags: 64 });
      return;
    }

    const active = await getActivePoll();
    if(!active){
      await interaction.reply({ content: '❌ No active poll found.', flags: 64 });
      return;
    }

    const { msgId, poll } = active;
    const podCount = poll.options.filter(o => o.label.toLowerCase().includes('pod')).length;

    if(podCount === 0){
      await interaction.reply({ content: '❌ There are no extra pods to remove.', flags: 64 });
      return;
    }

    // Remove all pods
    poll.options = poll.options.filter(o => !o.label.toLowerCase().includes('pod'));
    // Unlock any base options that were locked
    poll.options.forEach(o => { o.locked = o.votes.length >= CAP; });

    await savePoll(msgId, poll);

    try {
      const channel = await client.channels.fetch(process.env.POLL_CHANNEL_ID);
      const msg = await channel.messages.fetch(msgId);
      await msg.edit({ components: buildRows(poll) });
    } catch(e) {
      console.error('Could not update poll message:', e.message);
    }

    await interaction.reply({
      content: `✅ Removed all **${podCount}** extra pod(s) from the poll.`,
      flags: 64
    });
    return;
  }

  if(!interaction.isButton()) return;
  const [type, pollId, optId] = interaction.customId.split(':');

  if(type === 'show'){
    const poll = await loadPoll(interaction.message.id);
    if(!poll || poll.id !== pollId) return;
    const lines = poll.options.map(o =>
      `**${o.label}** (${o.votes.length}/${CAP}) → ${o.votes.length ? o.votes.map(id => `<@${id}>`).join(', ') : '—'}`
    );
    await interaction.reply({ content: lines.join('\n'), ephemeral: true });
    return;
  }

  if(type !== 'vote') return;

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    const res = await dbClient.query('SELECT data FROM polls WHERE message_id = $1 FOR UPDATE', [interaction.message.id]);
    const poll = res.rows.length ? res.rows[0].data : null;
    if(!poll || poll.id !== pollId){ await dbClient.query('ROLLBACK'); return; }

    const option = poll.options.find(o => o.id === optId);
    if(!option){ await dbClient.query('ROLLBACK'); return; }
    const userId = interaction.user.id;
    let changed = false;

    if(option.votes.includes(userId)){
      option.votes = option.votes.filter(id => id !== userId);
      changed = true;
      if(option.locked && option.votes.length < CAP) option.locked = false;
      changed = rebalance(option.base, poll) || changed;
    } else {
      if(option.locked){
        await dbClient.query('ROLLBACK');
        await interaction.reply({ content: 'That option is full (🔒). Choose another slot!', ephemeral: true });
        return;
      }
      option.votes.push(userId);
      changed = true;
      if(option.votes.length >= CAP){
        option.locked = true;
        const existingPods = poll.options.filter(o => o.base === option.base && o.label.toLowerCase().includes('pod'));
        if(!existingPods.some(o => !o.locked)){
          const newIndex = existingPods.length + 2;
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
    }

    if(changed){
      await dbClient.query(
        'INSERT INTO polls (message_id, data) VALUES ($1, $2) ON CONFLICT (message_id) DO UPDATE SET data = $2',
        [interaction.message.id, JSON.stringify(poll)]
      );
      await dbClient.query('COMMIT');
      await interaction.update({ components: buildRows(poll) });
    } else {
      await dbClient.query('ROLLBACK');
    }
  } catch(e) {
    await dbClient.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    dbClient.release();
  }
});

if(process.argv.includes('--register')){
  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  const commands = [
    new SlashCommandBuilder()
      .setName('poll')
      .setDescription('Post a new weekly availability poll')
      .addStringOption(opt =>
        opt.setName('days')
          .setDescription('Comma-separated days (e.g., Monday, Wednesday)')
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName('removepod')
      .setDescription('Remove a specific extra pod from the active poll')
      .addIntegerOption(opt =>
        opt.setName('number')
          .setDescription('Pod number to remove (omit to list available pods)')
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName('clearpods')
      .setDescription('Remove all extra pods from the active poll'),
  ];
  rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands.map(c => c.toJSON()) })
    .then(() => { console.log('✓ Slash commands registered'); process.exit(0); })
    .catch(console.error);
}

console.log('Waiting 10s before connecting to Discord...');
setTimeout(() => {
  https.get('https://discord.com/api/v10/gateway', (res) => {
    console.log('Discord gateway reachable, status:', res.statusCode);
  }).on('error', (err) => {
    console.error('Cannot reach Discord gateway:', err.message);
  });

  const loginTimeout = setTimeout(() => {
    console.error('✗ Discord login TIMED OUT after 15 seconds');
    process.exit(1);
  }, 15000);

  client.login(process.env.BOT_TOKEN)
    .then(() => {
      clearTimeout(loginTimeout);
      console.log('✓ Discord login successful');
    })
    .catch(err => {
      clearTimeout(loginTimeout);
      console.error('✗ Discord login FAILED:', err.message);
      process.exit(1);
    });
}, 10000);

pool.connect()
  .then(c => { console.log('✓ PostgreSQL connected'); c.release(); })
  .catch(err => console.error('✗ PostgreSQL connection FAILED:', err.message));

// Express server to keep the process alive
const app = express();
app.get('/', (req, res) => res.send('✅ Poll bot is running'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP server listening on port ${PORT}`));
