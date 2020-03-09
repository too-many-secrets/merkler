const async = require('async')
const dotenv = require('dotenv')
dotenv.config()
const admin = require('firebase-admin')
const Firestore = require('@google-cloud/firestore')
const path = require('path')
const db = new Firestore({
  projectId: process.env.GCP_PROJECT_ID,
  keyFilename: path.join(__dirname, process.env.GCP_FIRESTORE_KEYFILE)
})
const today = getMonthNumber() + '-' + getDOM() + '-' + getYear()
const dayDocRef = db.collection('day').doc(today)

function hasher (user, hash, exists, index, res) {
  const newUser = {
    userId: user,
    hashes: [hash],
    root: '',
    btcTx: '',
    ltcTx: '',
    tree: ''
  }
  const newDayDoc = {
    users: [newUser]
  }
  if (exists && index === -1) {
    console.log('In day exists and no user object')
    db.collection('day').doc(today).update({
      users: admin.firestore.FieldValue.arrayUnion(newUser)
    })
    return res.status(200).json({ status: 'added user object' })
  } else if (!exists && index === -2) {
    console.log('In day does not exist')
    dayDocRef.set(newDayDoc, { merge: true })
    return res.status(200).json({ status: 'added user' })
  } else if (exists && index > -1) {
    console.log('In day exists and user object exists')
    const getDayDoc = dayDocRef.get()
      .then(doc => {
        if (!doc.exists) console.log('No such document')
        else {
          // first, remove existing user object from users array
          console.log("DOC: " + JSON.stringify(doc.data()))
          const userObj = doc.data().users[index]
          console.log('userobj:' + JSON.stringify(userObj))
          let userArrRemove = dayDocRef.update({
            users: admin.firestore.FieldValue.arrayRemove(userObj)
          })
          // then add updated user object with new hash to users array
          let userHashes = userObj.hashes
          console.log('userHashes: ' + JSON.stringify(userHashes))
          console.log('typeof userHashes: ' + typeof userHashes)
          let userHashesArray = userHashes.push(hash)
          console.log('user hashes array after push: ' + userHashesArray)
          const newUserObj = {
            userId: user,
            hashes: userHashes,
            root: '',
            btcTx: '',
            ltcTx: '',
            tree: ''
          }
          console.log('new user object before update: ' + JSON.stringify(newUserObj))
          const userArrAdd = dayDocRef.update({
            users: admin.firestore.FieldValue.arrayUnion(newUserObj)
          })
          return res.status(200).json({ status: 'should have added updated hash' })
        }
      })
      .catch(err => console.log(err))
  }
}

function getDOM () {
  const daynow = new Date()
  return daynow.getUTCDate().toString()
}

function getMonthNumber () {
  const monthnow = new Date()
  return (monthnow.getUTCMonth() + 1).toString()
}

function getYear () {
  const yearnow = new Date()
  return yearnow.getUTCFullYear().toString()
}

exports.addHash = (req, res) => {
  const userName = req.body.userId
  const hash = req.body.hash
  console.log('un/hash: ' + userName + '/' + hash)
  const today = getMonthNumber() + '-' + getDOM() + '-' + getYear()
  const dayRef = db.doc('day/' + today)

  async.series([
    // dayExists
    function (callback) {
      dayRef.get().then(snapshot => {
        if (snapshot.exists) {
          callback(null, true)
        } else {
          callback(null, false)
        }
      })
    },
    // userIndex
    function (callback) {
      dayRef.get().then((doc) => {
        if (!doc.exists) {
          console.log('No such document!')
          callback(null, -2)
        } else {
          console.log(JSON.stringify(doc.data()))
          const dayDoc = doc.data()
          const usersArray = dayDoc.users
          console.log('usersArray: ' + JSON.stringify(usersArray))
          const ind = usersArray.findIndex(obj => obj.userId === userName)
          console.log('user index: ' + ind)
          callback(null, ind)
        }
      })
        .catch(err => console.log(err))
    }
  ], function (err, results) {
    if (err) console.log(err)
    const dayExists = results[0]
    const userIndex = results[1]
    hasher(userName, hash, dayExists, userIndex, res)
  })
}
