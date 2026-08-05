const crypto = require('crypto')

function generateRandomString(length: number = 64) {
    return crypto.randomBytes(Math.ceil(length / 2))
        .toString('hex')
        .slice(0, length)
}

function generateBase64String(length = 32) {
    return crypto.randomBytes(Math.ceil(length * 3 / 4))
        .toString('base64')
        .slice(0, length)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '')
}


console.log(generateRandomString(64))

export default generateRandomString