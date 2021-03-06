import express from 'express';
import fetch from 'node-fetch';
import spaces from '@bonustrack/snapshot-spaces';
import redis from './helpers/redis';
import db from './helpers/mysql';
import relayer from './helpers/relayer';
import { pinJson } from './helpers/ipfs';
import { verify, jsonParse, sendError } from './helpers/utils';
import { sendMessage } from './helpers/discord';
import pkg from '../package.json';
import {
  storeProposal as redisStoreProposal,
  storeVote as redisStoreVote
} from './helpers/connectors/redis';
import {
  storeProposal as mysqlStoreProposal,
  storeVote as mysqlStoreVote
} from './helpers/connectors/mysql';

const network = process.env.NETWORK || 'testnet';
const router = express.Router();

router.get('/', (req, res) => {
  return res.json({
    name: pkg.name,
    network,
    version: pkg.version,
    relayer: relayer.address
  });
});

router.get('/spaces/:key?', (req, res) => {
  const { key } = req.params;
  return res.json(key ? spaces[key] : spaces);
});

router.get('/:token/proposals', async (req, res) => {
  const { token } = req.params;
  const query = "SELECT * FROM messages WHERE type = 'proposal' AND token = ? ORDER BY timestamp DESC";
  db.queryAsync(query, [token]).then(messages => {
    const proposals = Object.fromEntries(
      messages.map(message => {
        const metadata = JSON.parse(message.metadata);
        return [message.id, {
          address: message.address,
          msg: {
            version: message.version,
            timestamp: message.timestamp.toString(),
            token: message.token,
            type: message.type,
            payload: JSON.parse(message.payload)
          },
          sig: message.sig,
          authorIpfsHash: message.id,
          relayerIpfsHash: metadata.relayer_ipfs_hash
        }];
      })
    );
    res.json(proposals);
  });
});

router.get('/:token/proposal/:id', async (req, res) => {
  const { token, id } = req.params;
  let votes = await redis.hgetallAsync(`token:${token}:proposal:${id}:votes`) || {};
  if (votes)
    votes = Object.fromEntries(Object.entries(votes).map((vote: any) => {
      vote[1] = JSON.parse(vote[1]);
      return vote;
    }));
  return res.json(votes);
});

router.post('/message', async (req, res) => {
  const body = req.body;
  const msg = jsonParse(body.msg);
  const ts = (Date.now() / 1e3).toFixed();
  // const minBlock = (3600 * 24) / 15;

  if (!body || !body.address || !body.msg || !body.sig)
    return sendError(res, 'wrong message body');

  if (
    Object.keys(msg).length !== 5 ||
    !msg.token ||
    !msg.payload ||
    Object.keys(msg.payload).length === 0
  ) return sendError(res, 'wrong signed message');

  if (!msg.timestamp || typeof msg.timestamp !== 'string' || msg.timestamp > (ts + 30))
    return sendError(res, 'wrong timestamp');

  if (!msg.version || msg.version !== pkg.version)
    return sendError(res, 'wrong version');

  if (!msg.type || !['proposal', 'vote'].includes(msg.type))
    return sendError(res, 'wrong message type');

  if (!await verify(body.address, body.msg, body.sig))
    return sendError(res, 'wrong signature');

  if (msg.type === 'proposal') {
    if (
      Object.keys(msg.payload).length !== 7 ||
      !msg.payload.choices ||
      msg.payload.choices.length < 2 ||
      !msg.payload.snapshot ||
      !msg.payload.metadata
    ) return sendError(res, 'wrong proposal format');

    if (
      !msg.payload.name ||
      msg.payload.name.length > 256 ||
      !msg.payload.body ||
      msg.payload.body.length > 4e4
    ) return sendError(res, 'wrong proposal size');

    if (
      typeof msg.payload.metadata !== 'object' ||
      JSON.stringify(msg.payload.metadata).length > 2e4
    ) return sendError(res, 'wrong proposal metadata');

    if (
      !msg.payload.start ||
      // ts > msg.payload.start ||
      !msg.payload.end ||
      msg.payload.start >= msg.payload.end
    ) return sendError(res, 'wrong proposal period');
  }

  if (msg.type === 'vote') {
    if (
      Object.keys(msg.payload).length !== 3 ||
      !msg.payload.proposal ||
      !msg.payload.choice ||
      !msg.payload.metadata
    ) return sendError(res, 'wrong vote format');

    if (
      typeof msg.payload.metadata !== 'object' ||
      JSON.stringify(msg.payload.metadata).length > 1e4
    ) return sendError(res, 'wrong vote metadata');

    const proposalRedis = await redis.hgetAsync(`token:${msg.token}:proposals`, msg.payload.proposal);
    const proposal = jsonParse(proposalRedis);
    if (!proposalRedis)
      return sendError(res, 'unknown proposal');
    if (
      ts > proposal.msg.payload.end ||
      proposal.msg.payload.start > ts
    ) return sendError(res, 'not in voting window');
  }

  const authorIpfsRes = await pinJson(`snapshot/${body.sig}`, {
    address: body.address,
    msg: body.msg,
    sig: body.sig,
    version: '2'
  });

  const relayerSig = await relayer.signMessage(authorIpfsRes);
  const relayerIpfsRes = await pinJson(`snapshot/${relayerSig}`, {
    address: relayer.address,
    msg: authorIpfsRes,
    sig: relayerSig,
    version: '2'
  });

  if (msg.type === 'proposal') {
    await Promise.all([
      redisStoreProposal(msg.token, body, authorIpfsRes, relayerIpfsRes),
      mysqlStoreProposal(msg.token, body, authorIpfsRes, relayerIpfsRes),
    ]);

    let message = `#${msg.token}\n\n`;
    message += `**${msg.payload.name}**\n\n`;
    message += `${msg.payload.body}\n\n`;
    message += `<https://ipfs.fleek.co/ipfs/${authorIpfsRes}>`;
    sendMessage(message);
  }

  if (msg.type === 'vote') {
    await Promise.all([
      redisStoreVote(msg.token, body, authorIpfsRes, relayerIpfsRes),
      mysqlStoreVote(msg.token, body, authorIpfsRes, relayerIpfsRes),
    ]);
  }

  fetch('https://snapshot.collab.land/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      network,
      body,
      authorIpfsRes,
      relayerIpfsRes
    })
  })
    .then(res => res.json())
    .then(json => console.log('Webhook success', json))
    .catch(result => console.error('Webhook error', result));

  console.log(
    `Address "${body.address}"\n`,
    `Token "${msg.token}"\n`,
    `Type "${msg.type}"\n`,
    `IPFS hash "${authorIpfsRes}"`
  );

  return res.json({ ipfsHash: authorIpfsRes });
});

export default router;
