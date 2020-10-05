const dotenv = require('dotenv')
dotenv.config()
const express = require('express')
const bodyParser = require('body-parser')

// API Controllers
const merkler = require('./merkler.js')

// Create Express Server and Configuration
const app = express()
app.set('port', process.env.PORT)
app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: true }))

// Route
app.post('/addHash', merkler.addHash)
app.post('/merk', merkler.merk)

app.get('/', function (req, res) {
  res.send('YOU ARE GETTING WHEN YOU SHOULD BE POSTING')
})
// Spin Up Server
app.listen(app.get('port'))