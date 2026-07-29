/**
 * Recursively inventory Google Sheets beneath the payout-workbooks folder.
 *
 * Configure Script Property:
 *   PAYOUT_WORKBOOKS_FOLDER_ID=<folder id>
 *
 * Output:
 *   sanitized/relative/path<TAB>spreadsheetId
 *
 * This script is read-only. Duplicate spreadsheet IDs are intentionally
 * preserved so the local validator can reject ambiguous inventory.
 */
function listPayoutWorkbooks() {
  var propertyName = "PAYOUT_WORKBOOKS_FOLDER_ID";
  var folderId = String(
    PropertiesService.getScriptProperties().getProperty(propertyName) || ""
  ).trim();

  if (!folderId) {
    throw new Error("Missing Apps Script property " + propertyName + ".");
  }

  var rows = [];
  var visitedFolders = Object.create(null);

  function sanitizeSegment(value) {
    var sanitized = String(value || "")
      .replace(/[\t\r\n]+/g, " ")
      .replace(/[\/\\]+/g, "／")
      .replace(/\s+/g, " ")
      .trim();
    return sanitized || "(unnamed)";
  }

  function walk(folder, parentSegments) {
    var currentFolderId = folder.getId();
    if (visitedFolders[currentFolderId]) return;
    visitedFolders[currentFolderId] = true;

    var files = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
    while (files.hasNext()) {
      var file = files.next();
      var relativePath = parentSegments
        .concat([sanitizeSegment(file.getName())])
        .join("/");
      rows.push([relativePath, file.getId()]);
    }

    var childFolders = [];
    var folders = folder.getFolders();
    while (folders.hasNext()) childFolders.push(folders.next());
    childFolders.sort(function (left, right) {
      var nameOrder = sanitizeSegment(left.getName()).localeCompare(
        sanitizeSegment(right.getName())
      );
      return nameOrder || left.getId().localeCompare(right.getId());
    });
    for (var index = 0; index < childFolders.length; index += 1) {
      var child = childFolders[index];
      walk(child, parentSegments.concat([sanitizeSegment(child.getName())]));
    }
  }

  walk(DriveApp.getFolderById(folderId), []);
  rows.sort(function (left, right) {
    return left[0].localeCompare(right[0])
      || left[1].localeCompare(right[1]);
  });

  var output = rows.map(function (row) {
    return row[0] + "\t" + row[1];
  }).join("\n");
  console.log(output);
  return output;
}
