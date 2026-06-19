/* global create: writeable */

create = global.create

function createXML (data) {
  const xml = create()
    .ele(data)
    .end({ prettyPrint: true })
  return xml
}

function createCompactXML (data) {
  return create()
    .ele(data)
    .end({ prettyPrint: false })
}

module.exports = createXML
module.exports.createCompactXML = createCompactXML
