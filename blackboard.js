const SHA256 = require('crypto-js/sha256')






let dayArray=[]
const leaves = ['hello'].map(x => SHA256(x))
console.log(leaves.toString('hex'))

function userExists (user) {
  const isUserIndex = (element) => element.user === user
  return dayArray.findIndex(isUserIndex) //not there if -1, otherwise index position returned
}



}
let obj = arr.find(o => o.name === 'string 1');



exports.addHash = (req, res) => {
  const user = req.body.user
  const hash = req.body.hash
  if (userExists(user) === -1) dayArray.push
}
