const dotenv = require('dotenv')
dotenv.config()
const path = require('path')
const sha256File = require('sha256-file')
const async = require('async')
const fetch = require('node-fetch')
const fs = require('fs-extra')
const Hashids = require('hashids/cjs')
const { Storage } = require('@google-cloud/storage')
const storage = new Storage({
  projectId: process.env.GCP_PROJECT_ID,
  keyFilename: path.join(__dirname, process.env.GCP_STORAGE_KEYFILE)
})
const bucket = storage.bucket(process.env.BUCKET_NAME)
const Firestore = require('@google-cloud/firestore')
const db = new Firestore({
  projectId: process.env.GCP_PROJECT_ID,
  keyFilename: path.join(__dirname, process.env.GCP_FIRESTORE_KEYFILE)
})
const tmpPOD = '/tmp/pod.png'
const gcpPODpath = 'POD/' + getMonthNumber() + '-' + getDOM() + '-' + getYear() + '-' + 'POD.png'
const PODpath = process.env.EINSTEIN_BUCKET + gcpPODpath
const ids = ['1', '2', '3', '4', '5', '7', '10', '11', '25', '26', '35', '101', '113', '139', '142']
const hashids = new Hashids(':thonk:')
let mappedIDs = []
const day = {
  epoch: '',
  dayOfWeek: '',
  dayOfMonth: '',
  month: '',
  year: '',
  dailyPicLink: PODpath,
  dailyPicHash: '',
  ids: ids,
  btcBlockInfo: {
    height: 0,
    hash: '',
    time: '',
    latest_url: '',
    previous_hash: '',
    previous_url: ''
  },
  ltcBlockInfo: {
    height: 0,
    hash: '',
    time: '',
    latest_url: '',
    previous_hash: '',
    previous_url: ''
  },
  pings: []
}
const secureDay = {
  day: {},
  blockLock: {
    dayFileLink: '',
    dayFileHash: '',
    btcHash: '',
    ltcHash: ''
  }
}
day.epoch = Date.now().toString()
day.dayOfWeek = getDOW()
day.dayOfMonth = getDOM()
day.month = getMonth()
day.year = getYear()

function getDOM () {
  const daynow = new Date()
  return daynow.getUTCDate().toString()
}

function getDOW () {
  const daynow = new Date()
  const dow = daynow.getUTCDay().toString()
  if (dow === '0') return 'Sunday'
  if (dow === '1') return 'Monday'
  if (dow === '2') return 'Tuesday'
  if (dow === '3') return 'Wednesday'
  if (dow === '4') return 'Thursday'
  if (dow === '5') return 'Friday'
  if (dow === '6') return 'Saturday'
}

function getYear () {
  const yearnow = new Date()
  return yearnow.getUTCFullYear().toString()
}

function getMonth () {
  const monthnow = new Date()
  const month = monthnow.getUTCMonth().toString()
  if (month === '0') return 'January'
  if (month === '1') return 'February'
  if (month === '2') return 'March'
  if (month === '3') return 'April'
  if (month === '4') return 'May'
  if (month === '5') return 'June'
  if (month === '6') return 'July'
  if (month === '7') return 'August'
  if (month === '8') return 'September'
  if (month === '9') return 'October'
  if (month === '10') return 'November'
  if (month === '11') return 'December'
}

function getMonthNumber () {
  const monthnow = new Date()
  return (monthnow.getUTCMonth() + 1).toString()
}

function getHash (input) {
  return sha256File(input)
}

function translator (callback) {
  mappedIDs = ids.map(x => hashids.encode(x))
  callback(null, mappedIDs)
}

function savePOD (callback) {
  fetch('https://lanlsource.lanl.gov/pics/picoftheday.png')
    .then(res => {
      const dest = fs.createWriteStream(tmpPOD)
      res.body.pipe(dest)
      dest.on('error', (err) => console.log(err))
      dest.on('finish', function () {
        const gcpPODObject = {
          gzip: true,
          public: true,
          destination: gcpPODpath,
          metadata: {
            cacheControl: 'public, max-age=31536000'
          }
        }
        bucket.upload(tmpPOD, gcpPODObject)
          .then(() => {
            day.dailyPicHash = getHash(tmpPOD)
            callback(null, gcpPODpath)
            fs.removeSync(tmpPOD)
          })
          .catch(err => console.log(err))
      })
    })
}

function saveHTML (callback) {
  for (let i = 0; i <= ids.length - 1; i++) {
    const tmpHTML = '/tmp/' + ids[i] + '.html'
    const gcpHTMLpath = 'html/' + getMonthNumber() + '-' + getDOM() + '-' + getYear() + '-Idea-ID-' + ids[i] + '.html'
    const gcpHTMLObject = {
      gzip: true,
      public: true,
      destination: gcpHTMLpath,
      metadata: {
        cacheControl: 'public, max-age=31536000'
      }
    }
    const pingObj = {
      id: ids[i],
      translated: mappedIDs[i],
      ideaURL: 'https://beta.ideablock.io/idea/' + mappedIDs[i],
      htmlLink: 'https://storage.googleapis.com/ideablock-einstein/' + gcpHTMLpath,
      htmlHash: '',
      archiveLink: null
    }
    fetch('https://beta.ideablock.io/idea/' + mappedIDs[i])
      .then(res => {
        const dest = fs.createWriteStream(tmpHTML)
        res.body.pipe(dest)
        dest.on('error', (err) => console.log(err))
        dest.on('finish', function () {
          pingObj.htmlHash = getHash(tmpHTML)
          bucket.upload(tmpHTML, gcpHTMLObject)
            .then(() => {
              day.pings.push(pingObj)
              if (day.pings.length === mappedIDs.length) {
                callback(null, day.pings)
              }
            })
            .catch(err => console.log(err))
        })
      })
  }
}

function blockClock (callback) {
  fetch('https://api.blockcypher.com/v1/btc/main')
    .then(res => res.json())
    .then(json => {
      day.btcBlockInfo.height = json.height
      day.btcBlockInfo.hash = json.hash
      day.btcBlockInfo.time = json.time
      day.btcBlockInfo.latest_url = json.latest_url
      day.btcBlockInfo.previous_hash = json.previous_hash
      day.btcBlockInfo.previous_url = json.previous_url
      fetch('https://api.blockcypher.com/v1/ltc/main')
        .then(res => res.json())
        .then(json => {
          day.ltcBlockInfo.height = json.height
          day.ltcBlockInfo.hash = json.hash
          day.ltcBlockInfo.time = json.time
          day.ltcBlockInfo.latest_url = json.latest_url
          day.ltcBlockInfo.previous_hash = json.previous_hash
          day.ltcBlockInfo.previous_url = json.previous_url
          callback(null, day.ltcBlockInfo)
        })
    })
    .catch(err => console.log(err))
}

function archiveIdeas (res) {
  let nullCount = 0
  async.eachOfSeries(day.pings, function (item, key, callback) {
    if (item.archiveLink == null) {
      setTimeout(function () {
        fetch('https://web.archive.org/save/https://beta.ideablock.io/idea/' + item.translated)
          .then(res => {
            if (res.headers.get('content-location') === null) {
              nullCount++
              callback()
            } else {
              day.pings[key].archiveLink = 'https://web.archive.org' + res.headers.get('content-location')
              callback()
            }
          })
      }, 50)
    } else {
      callback()
    }
  }, function (err) {
    if (err) console.log(err)
    if (nullCount > 0) {
      nullCount = 0
      setTimeout(function () {
        archiveIdeas(res)
      }, 7000)
    } else tether(res)
  })
}

function tether (res) {
  const dayString = JSON.stringify(day)
  const tmpDayFile = '/tmp/' + getMonthNumber() + '-' + getDOM() + '-' + getYear() + '-Day.json'
  const gcpDayFilePath = 'day/' + getMonthNumber() + '-' + getDOM() + '-' + getYear() + '-Day.json'
  const gcpDayObject = {
    gzip: true,
    public: true,
    destination: gcpDayFilePath,
    metadata: {
      cacheControl: 'public, max-age=31536000'
    }
  }
  fs.writeFile(tmpDayFile, dayString, 'utf8', err => {
    if (err) return console.error(err)
    const dayFileHash = getHash(tmpDayFile)
    secureDay.day = day
    secureDay.blockLock.dayFileHash = dayFileHash
    secureDay.blockLock.dayFileLink = process.env.EINSTEIN_BUCKET + gcpDayFilePath
    bucket.upload(tmpDayFile, gcpDayObject)
      .then(() => {
        const tetherBody = {
          userID: 'einstein',
          hash: dayFileHash
        }
        fetch('https://tether.ideablock.io', {
          method: 'post',
          body: JSON.stringify(tetherBody),
          headers: { 'Content-Type': 'application/json' }
        })
          .then(res => res.json())
          .then(json => {
            secureDay.blockLock.btcHash = json.btcTx
            secureDay.blockLock.ltcHash = json.ltcTx
            const dayRef = db.collection('day').doc(getMonthNumber() + '-' + getDOM() + '-' + getYear())
            dayRef.set(secureDay, { merge: true })
            return res.status(200).json(secureDay)
          })
          .catch(err => console.log(err))
      })
  })
}

exports.prove = (req, res) => {
  fs.emptyDirSync('/tmp')
  async.series([translator, savePOD, saveHTML, blockClock], (err) => {
    if (err) console.log(err)
    archiveIdeas(res)
  })
}
