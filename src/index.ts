import { config } from 'dotenv'
config({ path: process.env.NODE_ENV === 'production' ? './env_production.env' : './env_development.env' })

import mongoose from 'mongoose'
import { connectServer } from './server'
import {
  blogSubscriberInit,
  commentSubscriberInit,
  userSubscriberInit,
  runBlogCronJobs,
  runCommentCronJobs,
  runUserCronJobs,
} from './modules'
import { createClient } from 'redis'
import { eventAdminInit } from 'event-driven'
import { Subjects } from './interfaces'

/*
  - We need to make sure __v is updated on every update. 
    This also solves the order issue, when we deal event sourcing
  - New consumer able to get messages from past(S3) and smoothly transition to new messages
    - if old messages are in old versions, update it on demand
      (even though old version messages will be processed to new version messages,
       there might be delays, if there is a huge amount of messages)


  TODO    
  - XINFO GROUPS User.nameUpdated
  - XINFO CONSUMERS User.nameUpdated consumerA
  - XLEN User.nameUpdated
  - EXIST User.nameUpdated
  - XGROUP DESTORY User.nameUpdated Blog
  - XGROUP DELCONSUMER User.nameUpdated Blog instance1
  - XPENDING to check idle pending messages, XCLAIM
  - trim on every publish XADD User.nameUpdated MAXLEN ~ 1000 * foo bar
    or trim regularly with XTRIM User.napeUpdated MAXLEN ~ 1000 this seems better

  // await redis.sendCommand(['CLIENT', 'SETNAME', 'NODEJS'])  
*/

//when adding a new service, a stream must be created with default subjects(*)

const start = async () => {
  //@ts-ignore
  try {
    let { NODE_ENV, PORT, MONGO_URI, ACCESS_TOKEN_SECRET, REDIS_URI, pm_id } = process.env
    console.log(`\nMode: ${NODE_ENV}\n`)
    if (!PORT) throw new Error('PORT is required!')
    if (!MONGO_URI) throw new Error('MONGO_URI is required!')
    if (!REDIS_URI) throw new Error('REDIS_URI is required!')
    if (!ACCESS_TOKEN_SECRET) throw new Error('ACCESS_TOKEN_SECRET is required!')
    if (process.env.NODE_ENV === 'production' && !pm_id)
      throw new Error(
        'pm_id is required in production environment! Its a unique NODEJS_INSTANCE_ID, generated by pm2 clustering. This is required, for horizontal scaling, in order to make consumer groups with Redis Stream'
      )
    if (!pm_id) pm_id = 'dev_consumer'

    // mongoose.set('debug', true)
    await mongoose.connect(MONGO_URI)
    console.log('🌱 MongoDB connected')
    mongoose.connection.on('error', (err) => {
      console.error('mongoose connection error - ', err)
      process.exit()
    })
    mongoose.connection.on('disconnected', (err) => {
      console.error('mongoose connection disconnected - ', err)
      process.exit()
    })

    const redis = createClient({
      url: REDIS_URI,
    })
    redis.on('error', (err) => console.log('Redis Client Error', err))
    await redis.connect()
    console.log('📕 Redis connected')

    if (pm_id === '0' || NODE_ENV === 'development') await eventAdminInit(Object.values(Subjects), MONGO_URI, 'event-admin')
    await Promise.all([blogSubscriberInit(redis, pm_id), commentSubscriberInit(redis, pm_id), userSubscriberInit(redis, pm_id)])
    console.log('✨ Message Broker & Event Store connected')

    if (pm_id === '0') {
      //Cronjobs are only executed by the one instance in the node cluster. Otherwise cronjobs will be duplicated
      runBlogCronJobs(redis)
      runCommentCronJobs(redis)
      runUserCronJobs(redis)
    }

    await connectServer({ ACCESS_TOKEN_SECRET, redis, PORT: parseInt(PORT) })
  } catch (err) {
    console.error(err)
    console.log('========process exiting===========')
    process.exit()
  }
}

start()
// process.on('SIGINT', () => nsc.close())
//   process.on('SIGTERM', () => nsc.close())
