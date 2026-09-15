'use strict';
/**
 * A Google Docs and Drive fake with enough behaviour to be worth testing against.
 *
 * The manual parser reads heading structure, so a fake that cannot hold a heading
 * would let the whole format contract pass without ever being exercised.
 *
 * This one stores real children with real types and real headings, and lets a
 * test break a heading exactly the way a person would in Google Docs.
 *
 * Shared by tests/integration.js and tests/emulator.js so the offline suite and
 * the clickable emulator cannot drift apart on what a Doc is.
 */

var HEADINGS = { NORMAL: 'NORMAL', HEADING1: 'HEADING1', HEADING2: 'HEADING2', HEADING3: 'HEADING3', HEADING4: 'HEADING4', TITLE: 'TITLE', SUBTITLE: 'SUBTITLE' };

function Text(child) { this.child = child; }
Text.prototype.setFontFamily = function () { return this; };
Text.prototype.setFontSize = function () { return this; };
Text.prototype.setBold = function () { return this; };
Text.prototype.setForegroundColor = function (colour) { this.child.colour = colour; return this; };

function Child(type, text, heading) {
  this.type = type;
  this.text = String(text == null ? '' : text);
  this.heading = heading || HEADINGS.NORMAL;
  this.colour = '';
}
Child.prototype.getType = function () { return this.type; };
Child.prototype.getText = function () { return this.text; };
Child.prototype.setHeading = function (heading) { this.heading = heading; return this; };
Child.prototype.getHeading = function () { return this.heading; };
Child.prototype.asParagraph = function () { return this; };
Child.prototype.asTable = function () { return this; };
Child.prototype.editAsText = function () { return new Text(this); };
Child.prototype.setSpacingBefore = function () { return this; };
Child.prototype.setSpacingAfter = function () { return this; };
Child.prototype.setLineSpacing = function () { return this; };

function Cell(text) { this.text = String(text == null ? '' : text); }
Cell.prototype.getText = function () { return this.text; };
Cell.prototype.setBackgroundColor = function () { return this; };
Cell.prototype.editAsText = function () { return new Text(this); };

function Table(rows) {
  this.type = 'TABLE';
  this.rows = (rows || []).map(function (row) { return (row || []).map(function (value) { return new Cell(value); }); });
}
Table.prototype.getType = function () { return this.type; };
Table.prototype.getText = function () { return this.rows.map(function (row) { return row.map(function (cell) { return cell.getText(); }).join(' '); }).join('\n'); };
Table.prototype.asTable = function () { return this; };
Table.prototype.getNumRows = function () { return this.rows.length; };
Table.prototype.getRow = function (index) { var row = this.rows[index]; return { getNumCells: function () { return row.length; }, getCell: function (i) { return row[i]; } }; };

function Body(doc) { this.doc = doc; this.children = []; }
Body.prototype.clear = function () { this.children = []; return this; };
Body.prototype.getNumChildren = function () { return this.children.length; };
Body.prototype.getChild = function (index) { return this.children[index]; };
Body.prototype.appendParagraph = function (text) { var child = new Child('PARAGRAPH', text); this.children.push(child); this.doc.touch(); return child; };
Body.prototype.appendListItem = function (text) { var child = new Child('LIST_ITEM', text); this.children.push(child); this.doc.touch(); return child; };
Body.prototype.appendTable = function (rows) { var table = new Table(rows); this.children.push(table); this.doc.touch(); return table; };
Body.prototype.setMarginTop = function () { return this; };
Body.prototype.setMarginBottom = function () { return this; };
Body.prototype.setMarginLeft = function () { return this; };
Body.prototype.setMarginRight = function () { return this; };

function Doc(id, name, clock) {
  this.id = id;
  this.name = name;
  this.clock = clock;
  this.body = new Body(this);
  this.modifiedAt = clock();
  this.lastEditor = { displayName: 'Sample East Manager', emailAddress: 'regional@example.org' };
}
Doc.prototype.getId = function () { return this.id; };
Doc.prototype.getName = function () { return this.name; };
Doc.prototype.getBody = function () { return this.body; };
Doc.prototype.saveAndClose = function () { return this; };
Doc.prototype.touch = function () { this.modifiedAt = this.clock(); };

/**
 * Build the fakes.
 *
 * `clock` lets a test move the Doc's modified time on demand, which is how the
 * on-read freshness short-circuit gets proved rather than assumed.
 */
function build(options) {
  options = options || {};
  var docs = {}, files = {}, folders = {}, seq = 0;
  var now = options.now || function () { return new Date().toISOString(); };

  function file(id, name, parentId) {
    var record = {
      id: id, name: name, parentId: parentId || 'root',
      getId: function () { return id; },
      getName: function () { return docs[id] ? docs[id].name : name; },
      getUrl: function () { return 'https://docs.google.com/document/d/' + id + '/edit'; },
      getLastUpdated: function () { return docs[id] ? new Date(docs[id].modifiedAt) : new Date(0); },
      getOwner: function () { return { getName: function () { return 'Workspace Owner'; }, getEmail: function () { return options.ownerEmail || 'admin@example.org'; } }; },
      getParents: function () {
        var parents = folders[record.parentId] ? [folders[record.parentId]] : [];
        var i = 0;
        return { hasNext: function () { return i < parents.length; }, next: function () { return parents[i++]; } };
      },
      moveTo: function (target) { record.parentId = target.getId(); return record; },
      makeCopy: function (copyName, target) { return file('copy-' + (++seq), copyName || name, target ? target.getId() : 'root'); },
      setTrashed: function () {}
    };
    files[id] = record;
    return record;
  }
  function folder(id, name) {
    var record = { id: id, name: name, getId: function () { return id; }, getName: function () { return name; } };
    folders[id] = record;
    return record;
  }
  folder('root', 'My Drive');
  folder('workspace-folder', 'Workspace');

  var DocumentApp = {
    ParagraphHeading: HEADINGS,
    create: function (name) {
      var id = 'doc-' + (++seq);
      docs[id] = new Doc(id, name, now);
      file(id, name, 'root');
      return docs[id];
    },
    openById: function (id) {
      if (!docs[id]) { throw new Error('Document is missing: ' + id); }
      return docs[id];
    }
  };

  var DriveApp = {
    getFileById: function (id) {
      if (!files[id]) { throw new Error('File is missing: ' + id); }
      return files[id];
    },
    getFolderById: function (id) { return folders[id]; },
    getRootFolder: function () { return folders.root; }
  };

  var fetched = [];
  var UrlFetchApp = {
    fetch: function (url) {
      fetched.push(url);
      if (options.driveApiFails) { throw new Error('external request refused'); }
      var match = String(url).match(/files\/([^?]+)/);
      var doc = match ? docs[decodeURIComponent(match[1])] : null;
      if (!doc) { return { getResponseCode: function () { return 404; }, getContentText: function () { return '{}'; } }; }
      var payload = JSON.stringify({ modifiedTime: doc.modifiedAt, lastModifyingUser: doc.lastEditor });
      return { getResponseCode: function () { return 200; }, getContentText: function () { return payload; } };
    }
  };

  return {
    DocumentApp: DocumentApp,
    DriveApp: DriveApp,
    UrlFetchApp: UrlFetchApp,
    docs: docs,
    files: files,
    fetched: fetched,
    /* The test's hands on the Doc, doing what a person does in Google Docs. */
    doc: function (id) { return docs[id]; },
    childIndex: function (id, text) {
      var body = docs[id].getBody();
      for (var i = 0; i < body.getNumChildren(); i++) {
        if (String(body.getChild(i).getText()).trim() === String(text).trim()) { return i; }
      }
      return -1;
    },
    rename: function (id, from, to) {
      var index = this.childIndex(id, from);
      if (index === -1) { throw new Error('no such line in the fake Doc: ' + from); }
      docs[id].getBody().getChild(index).text = to;
      docs[id].touch();
      return index;
    },
    demote: function (id, text) {
      var index = this.childIndex(id, text);
      if (index === -1) { throw new Error('no such line in the fake Doc: ' + text); }
      docs[id].getBody().getChild(index).setHeading(HEADINGS.NORMAL);
      docs[id].touch();
      return index;
    },
    removeLine: function (id, text) {
      var index = this.childIndex(id, text);
      if (index === -1) { throw new Error('no such line in the fake Doc: ' + text); }
      docs[id].getBody().children.splice(index, 1);
      docs[id].touch();
      return index;
    },
    insertAfter: function (id, afterText, child) {
      var index = this.childIndex(id, afterText);
      if (index === -1) { throw new Error('no such line in the fake Doc: ' + afterText); }
      var made = child.kind === 'heading2' ? new Child('PARAGRAPH', child.text, HEADINGS.HEADING2)
        : child.kind === 'heading3' ? new Child('PARAGRAPH', child.text, HEADINGS.HEADING3)
          : new Child('LIST_ITEM', child.text);
      docs[id].getBody().children.splice(index + 1, 0, made);
      docs[id].touch();
      return made;
    },
    /* Select a whole section and delete it, which is what a person does when
       they mean to remove one, rather than deleting its lines one at a time. */
    removeSection: function (id, headingText) {
      var body = docs[id].getBody();
      var start = this.childIndex(id, headingText);
      if (start === -1) { throw new Error('no such section in the fake Doc: ' + headingText); }
      var end = start + 1;
      while (end < body.getNumChildren() && body.getChild(end).getHeading() !== HEADINGS.HEADING2) { end++; }
      body.children.splice(start, end - start);
      docs[id].touch();
      return end - start;
    },
    append: function (id, child) {
      var body = docs[id].getBody();
      var made = child.kind === 'heading2' ? new Child('PARAGRAPH', child.text, HEADINGS.HEADING2)
        : child.kind === 'heading3' ? new Child('PARAGRAPH', child.text, HEADINGS.HEADING3)
          : new Child('LIST_ITEM', child.text);
      body.children.push(made);
      docs[id].touch();
      return made;
    },
    colourOf: function (id, text) {
      var index = this.childIndex(id, text);
      return index === -1 ? '' : docs[id].getBody().getChild(index).colour;
    },
    headingOf: function (id, text) {
      var index = this.childIndex(id, text);
      return index === -1 ? '' : docs[id].getBody().getChild(index).getHeading();
    }
  };
}

module.exports = { build: build, HEADINGS: HEADINGS };
