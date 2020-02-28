const SHA256 = require('crypto-js/sha256')
const Firestore = require('@google-cloud/firestore')
const db = new Firestore({
  projectId: process.env.GCP_PROJECT_ID,
  keyFilename: path.join(__dirname, process.env.GCP_FIRESTORE_KEYFILE)
})





let dayArray=[]
const leaves = ['hello'].map(x => SHA256(x))
console.log(leaves.toString('hex'))




function getDayArray () {

}
function userExists (user) {
  const isUserIndex = (element) => element.user === user
  return dayArray.findIndex(isUserIndex) //not there if -1, otherwise index position returned
}



}
let obj = arr.find(o => o.name === 'string 1');



function addHash (req, res) {
  const user = req.body.user
  const hash = req.body.hash
  const userPos = userExists(user)
  if (userPos === -1) dayArray.push({ user: user, hashes: [hash]})
  else dayArray
}
