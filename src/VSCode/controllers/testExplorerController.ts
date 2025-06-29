import { ProcessArgumentBuilder } from '../interop/processArgumentBuilder';
import { DotNetTaskProvider } from '../providers/dotnetTaskProvider';
import { TestExtensions } from '../models/test';
import { Interop } from '../interop/interop';
import { Extensions } from '../extensions';
import { Icons } from '../resources/icons';
import * as res from '../resources/constants'
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class TestExplorerController {
    private static controller: vscode.TestController;
    private static testsResultDirectory: string;

    public static activate(context: vscode.ExtensionContext) {
        TestExplorerController.testsResultDirectory = path.join(context.extensionPath, "extension", "bin", "TestExplorer");

        TestExplorerController.controller = vscode.tests.createTestController(res.testExplorerViewId, res.testExplorerViewTitle);
        TestExplorerController.controller.refreshHandler = TestExplorerController.refreshTests;

        context.subscriptions.push(TestExplorerController.controller);
        context.subscriptions.push(TestExplorerController.controller.createRunProfile(res.testExplorerProfileRun, vscode.TestRunProfileKind.Run, TestExplorerController.runTests, true));
        context.subscriptions.push(TestExplorerController.controller.createRunProfile(res.testExplorerProfileDebug, vscode.TestRunProfileKind.Debug, TestExplorerController.debugTests, true));
        /* Experimental API */
        if (Extensions.getSetting(res.configIdTestExplorerAutoRefreshTests)) {
            context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(ev => {
                const fileName = path.basename(ev.uri.fsPath);
                if (fileName.endsWith('.cs') && fileName.includes('Test'))
                    TestExplorerController.refreshTests();
            }));
        }
        if (Extensions.getSetting(res.configIdTestExplorerSkipInitialPauseEvent) && Extensions.onVSCode(true, false)) {
            context.subscriptions.push(vscode.debug.registerDebugAdapterTrackerFactory(res.debuggerNetCoreId, new ContinueAfterInitialPauseTracker()));
        }
    }

    public static async loadProject(projectPath: string): Promise<void> {
        const projectName = path.basename(projectPath, '.csproj');
        const discoveredTests = await Interop.getTests(projectPath);
        if (discoveredTests === undefined || discoveredTests.length === 0)
            return;

        const root = TestExplorerController.controller.createTestItem(projectName, `${Icons.solution} ${projectName}`, vscode.Uri.file(projectPath));
        root.children.replace(discoveredTests.map(t => TestExtensions.fixtureToTestItem(t, TestExplorerController.controller)));
        TestExplorerController.controller.items.delete(root.id);
        TestExplorerController.controller.items.add(root);
    }
    public static unloadProjects() {
        TestExplorerController.controller.items.replace([]);
    }

    private static async refreshTests(): Promise<void> {
        await vscode.workspace.saveAll();

        const projectFiles: string[] = [];
        TestExplorerController.controller.items.forEach(item => projectFiles.push(item.uri!.fsPath));
        return Extensions.parallelForEach(projectFiles, async (projectFile) => await TestExplorerController.loadProject(projectFile));
    }
    private static async runTests(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
        TestExplorerController.convertTestRequest(request).forEach(async (filters, project) => {
            const preLaunchTask = await Extensions.getTask(Extensions.getSetting<string>(res.configIdTestExplorerPreLaunchTask));
            const testReport = path.join(TestExplorerController.testsResultDirectory, `${project.id}.trx`);
            if (fs.existsSync(testReport))
                vscode.workspace.fs.delete(vscode.Uri.file(testReport));

            const testArguments = new ProcessArgumentBuilder('test')
                .append('--logger').append(`'trx;LogFileName=${testReport}'`);

            testArguments.conditional('--no-build', () => preLaunchTask !== undefined);
            testArguments.conditional('--filter', () => filters.length > 0);
            testArguments.conditional(`'${filters.join('|')}'`, () => filters.length > 0);

            // Create a test run with the specified include/exclude tests
            const testRun = TestExplorerController.controller.createTestRun(request);

            // Collect all test items that will be included in this run
            const testItems = TestExplorerController.collectTestItems(project, filters);
            
            // Explicitly mark each test as enqueued
            testItems.forEach(item => testRun.enqueued(item));
            
            if (preLaunchTask !== undefined) {
                const executionSuccess = await Extensions.waitForTask(preLaunchTask);
                if (!executionSuccess || token.isCancellationRequested) {
                    testRun.end();
                    return;
                }
            }
            
            await Extensions.waitForTask(DotNetTaskProvider.getTestTask(project.uri!.fsPath, testArguments));
            await TestExplorerController.publishTestResults(testRun, project, testReport);
        });
    }
    private static async debugTests(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
        TestExplorerController.convertTestRequest(request).forEach(async (filters, project) => {
            const preLaunchTask = await Extensions.getTask(Extensions.getSetting<string>(res.configIdTestExplorerPreLaunchTask));
            const executionSuccess = await Extensions.waitForTask(preLaunchTask ?? DotNetTaskProvider.getBuildTask(project.uri!.fsPath));
            if (!executionSuccess || token.isCancellationRequested)
                return;

            const processId = await Interop.runTestHost(project.uri!.fsPath, filters.join('|'));
            await vscode.debug.startDebugging(Extensions.getWorkspaceFolder(), {
                name: res.testExplorerProfileDebug,
                type: res.debuggerNetCoreId,
                processId: processId,
                request: 'attach',
            });
        });
    }

    private static convertTestRequest(request: vscode.TestRunRequest): Map<vscode.TestItem, string[]> {
        const testItems = new Map<vscode.TestItem, string[]>();
        const getRootNode = (item: vscode.TestItem): vscode.TestItem => {
            if (item.parent === undefined)
                return item;
            return getRootNode(item.parent);
        }

        if (request.include === undefined) {
            TestExplorerController.controller.items.forEach(item => testItems.set(item, []));
            return testItems;
        }

        request.include?.forEach(item => {
            const rootNode = getRootNode(item);
            if (!testItems.has(rootNode))
                testItems.set(rootNode, []);
            if (item.id !== rootNode.id)
                testItems.get(rootNode)?.push(item.id);
        });

        return testItems;
    }
    private static collectTestItems(project: vscode.TestItem, filters: string[]): vscode.TestItem[] {
        const testItems: vscode.TestItem[] = [];
        
        // Recursive function to collect all test items in the tree
        const collectTestsInItem = (item: vscode.TestItem): void => {
            // If this is a test case (leaf node), collect it
            if (item.children.size === 0) {
                testItems.push(item);
                return;
            }
            
            // Otherwise, recursively collect all children
            item.children.forEach(child => {
                collectTestsInItem(child);
            });
        };
        
        // If specific filters are provided, only collect those tests
        if (filters.length > 0) {
            filters.forEach(filterId => {
                // Find the test item with this ID
                const findAndCollectItem = (container: vscode.TestItem, targetId: string): boolean => {
                    if (container.id === targetId) {
                        collectTestsInItem(container);
                        return true;
                    }
                    
                    let found = false;
                    container.children.forEach(child => {
                        if (!found) {
                            found = findAndCollectItem(child, targetId);
                        }
                    });
                    
                    return found;
                };
                
                findAndCollectItem(project, filterId);
            });
        } else {
            // No filters, collect all tests in the project
            collectTestsInItem(project);
        }
        
        return testItems;
    }
    
    private static publishTestResults(testRun: vscode.TestRun, project: vscode.TestItem, testReport: string): Promise<void> {
        const findTestItem = (id: string) => {
            const fixtureId = id.substring(0, id.lastIndexOf('.'));
            
            // Recursive function to search for a test item in the tree
            const searchInItem = (container: vscode.TestItem, targetId: string): vscode.TestItem | undefined => {
                // Check if this is the fixture we're looking for
                if (container.id === targetId) {
                    // If it's the fixture, look for the test case
                    return container.children.get(id);
                }
                
                // Check direct children first
                const directMatch = container.children.get(targetId);
                if (directMatch) {
                    return directMatch.children.get(id);
                }
                
                // Recursively search in all children
                let result: vscode.TestItem | undefined;
                container.children.forEach(child => {
                    if (!result) {
                        result = searchInItem(child, targetId);
                    }
                });
                
                return result;
            };
            
            // Start search from the project root
            return searchInItem(project, fixtureId);
        };

        return Interop.getTestResults(testReport).then(testResults => {
            // Process all test results we received
            if (testResults && testResults.length > 0) {
                testResults.forEach(result => {
                    const duration = TestExtensions.toDurationNumber(result.duration);
                    const testItem = findTestItem(result.fullName);
                    if (testItem === undefined)
                        return;

                    if (result.state === 'Passed') {
                        testRun.passed(testItem, duration);
                    } else if (result.state === 'Failed') {
                        testRun.failed(testItem, TestExtensions.toTestMessage(result), duration);
                    } else {
                        testRun.skipped(testItem);
                    }
                });
            }
            
            // End the test run
            testRun.end();
        });
    }
}

/* Experimental API */
// https://github.com/microsoft/vstest/blob/06101ef5feb95048cbe850472ed49604863d54ff/src/vstest.console/Program.cs#L37
class ContinueAfterInitialPauseTracker implements vscode.DebugAdapterTrackerFactory {
    private isInitialStoppedEvent: boolean = false;

    public createDebugAdapterTracker(session: vscode.DebugSession): vscode.ProviderResult<vscode.DebugAdapterTracker> {
        const self = this;
        return {
            onDidSendMessage(message: any) {
                if (session.name !== res.testExplorerProfileDebug)
                    return;

                if (message.type == 'response' && message.command == 'initialize')
                    self.isInitialStoppedEvent = true;
                if (message.type == 'event' && message.event == 'stopped' && self.isInitialStoppedEvent) {
                    session.customRequest('continue', { threadId: message.body.threadId });
                    self.isInitialStoppedEvent = false;
                }
            }
        }
    }
}