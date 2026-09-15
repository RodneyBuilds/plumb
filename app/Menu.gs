function onOpen() {
  SpreadsheetApp.getUi().createMenu(PRODUCT_NAME)
    .addItem('Set up this workspace', 'setupWorkspaceFromMenu_')
    .addItem('Add TEST data', 'seedTestDataFromMenu_')
    .addToUi();
}
function setupWorkspaceFromMenu_() { var result = setupWorkspace_(); SpreadsheetApp.getUi().alert('Workspace ready. ' + result.managedSheets + ' managed tabs checked.'); }
function seedTestDataFromMenu_() { var result = seedTestData_(); SpreadsheetApp.getUi().alert('TEST data ready. ' + result.intake + ' Intake request, ' + result.metrics + ' metrics, ' + result.goals + ' goals and ' + result.actuals + ' reported numbers.'); }
