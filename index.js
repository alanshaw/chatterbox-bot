const Os = require('os')
const Path = require('path')
const Fs = require('fs').promises
const IPFS = require('ipfs')
const Chatterbox = require('chatterbox-core')
const Crypto = require('crypto')
const Scrab = require('scrab')
const swarmBind = require('ipfs-swarm-bind-shim')

const Config = {
  name: process.env.CHATTERBOX_BOT_NAME || `chatterbot-${Crypto.randomBytes(4).toString('hex')}`,
  topics: {
    broadcast: process.env.CHATTERBOX_TOPIC_BROADCAST || '/chatterbox/broadcast',
    beacon: process.env.CHATTERBOX_TOPIC_BEACON || '/chatterbox/beacon'
  },
  repoPath: process.env.IPFS_PATH,
  relayAddrs: process.env.CHATTERBOX_RELAY_ADDRS
    ? process.env.CHATTERBOX_RELAY_ADDRS.split(',')
    : [],
  randomSentenceInterval: process.env.CHATTERBOX_BOT_RANDOM_SENTENCE_INTERVAL
    ? parseInt(process.env.CHATTERBOX_BOT_RANDOM_SENTENCE_INTERVAL)
    : 1000 * 60
}

async function main () {
  let stopped = false
  const cleanupTasks = []
  const stop = async () => {
    if (stopped) return
    stopped = true
    console.log('🛑 stopping chatterbot...')
    let errored = false
    while (cleanupTasks.length) {
      try {
        await cleanupTasks.pop()()
      } catch (err) {
        errored = true
        console.error(err)
      }
    }
    process.exit(errored ? 1 : 0)
  }

  process.on('SIGINT', stop).on('SIGTERM', stop)

  try {
    let usingTempRepo = false

    if (!Config.repoPath) {
      usingTempRepo = true
      Config.repoPath = Path.join(Os.tmpdir(), `chatterbox-bot-${Math.random()}`)
      console.log(`🤪 creating temporary repo at ${Config.repoPath} (use IPFS_PATH environment variable for permanent repo)`)
    }

    await Fs.mkdir(Config.repoPath, { recursive: true })

    if (usingTempRepo) {
      cleanupTasks.push(() => {
        console.log('🧹 removing temporary repo')
        return Fs.rmdir(Config.repoPath, { recursive: true })
      })
    }

    console.log('🌎 starting IPFS')

    const ipfs = await IPFS.create({
      repo: Config.repoPath,
      config: {
        Bootstrap: [],
        Addresses: {
          Swarm: ['/ip4/127.0.0.1/tcp/0']
        },
        Discovery: {
          MDNS: { Enabled: false },
          webRTCStar: { Enabled: false }
        }
      }
    })

    cleanupTasks.push(() => {
      console.log('🌎 stopping IPFS')
      return ipfs.stop()
    })

    if (Config.relayAddrs.length) {
      console.log(`🤗 binding to peers ${Config.relayAddrs}`)

      const cancel = await swarmBind(ipfs, Config.relayAddrs)
      cleanupTasks.push(() => {
        console.log('🤗 cancelling peer bindings')
        return cancel()
      })
    }

    console.log('📬 creating chatterbox core')

    const cbox = await Chatterbox(ipfs, { topics: Config.topics })

    cleanupTasks.push(() => {
      console.log('📬 destroying chatterbox core')
      return cbox.destroy()
    })

    let peerInfo = await cbox.peer.get()

    if (!peerInfo.name) {
      console.log(`📛 setting peer name to ${Config.name}`)
      await cbox.peer.set({ name: Config.name })
      peerInfo = await cbox.peer.get()
    }

    console.log('💬 starting random chat message interval')

    const intervalId = setInterval(async () => {
      try {
        await cbox.messages.broadcast(Scrab.sentence())
      } catch (err) {
        console.error('💥 failed to broadcast random message', err)
      }
    }, Config.randomSentenceInterval)

    cleanupTasks.push(() => {
      console.log('💬 clearing random chat message interval')
      clearInterval(intervalId)
    })

    console.log(`🤖 ${peerInfo.name} ready!`)
  } catch (err) {
    console.error(err)
    await stop()
  }
}

main().catch(console.error)
