#!/usr/bin/env node

/**
 * ComfyUI 工作流调用脚本（comfyui-client 技能捆绑版本）
 * 用于调用 ComfyUI 的工作流生成图片和视频
 *
 * 功能：
 * - 支持加载和修改工作流 JSON
 * - 支持提交工作流到 ComfyUI 队列
 * - 支持轮询获取生成结果
 * - 自动下载生成的图片和视频
 * - 支持会话管理和状态保存
 *
 * 使用方法（从项目根或用户工程根目录执行）：
 * node scripts/comfyUIClient.js [选项]
 * 或（作为 Claude 技能安装时）node .claude/skills/comfyui-client/scripts/comfyUIClient.js [选项]
 *
 * 选项：见 --help
 *
 * 版本: 1.0.0
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const { URL } = require('url');

/**
 * 解析「用户工程根目录」：用于 .env、work_dir 等。
 * - 独立克隆本仓库：技能根目录即工程根（scripts/ 的上一级）
 * - 安装在 .claude/skills/comfyui-client/ 下：工程根为 .claude 的上一级
 */
function resolveProjectRoot(scriptDir) {
    const skillRoot = path.resolve(scriptDir, '..');
    const skillsParent = path.resolve(skillRoot, '..');
    const dotClaudeParent = path.resolve(skillsParent, '..');
    if (path.basename(skillsParent) === 'skills' && path.basename(dotClaudeParent) === '.claude') {
        return path.resolve(dotClaudeParent, '..');
    }
    return skillRoot;
}

const projectRoot = resolveProjectRoot(__dirname);
require('dotenv').config({ path: path.join(projectRoot, '.env') });
global.rootDir = projectRoot;

function parseProxyUrl(value) {
    if (!value || !String(value).trim()) return null;
    const raw = String(value).trim();
    const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
    return new URL(withProtocol);
}

function proxyBasicAuthHeader(proxy) {
    if (!proxy.username) return null;
    const user = decodeURIComponent(proxy.username);
    const pass = decodeURIComponent(proxy.password || '');
    return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

function connectHttpProxyTunnel(proxy, target) {
    return new Promise((resolve, reject) => {
        const proxyPort = Number(proxy.port || 80);
        const targetPort = Number(target.port || 443);
        const socket = net.connect(proxyPort, proxy.hostname);
        let buffer = Buffer.alloc(0);
        let settled = false;

        const fail = (error) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            reject(error);
        };

        socket.setTimeout(20000, () => fail(new Error('连接 HTTP 代理超时')));
        socket.once('error', fail);
        socket.once('connect', () => {
            const lines = [
                `CONNECT ${target.hostname}:${targetPort} HTTP/1.1`,
                `Host: ${target.hostname}:${targetPort}`
            ];
            const auth = proxyBasicAuthHeader(proxy);
            if (auth) lines.push(`Proxy-Authorization: ${auth}`);
            lines.push('', '');
            socket.write(lines.join('\r\n'));
        });

        socket.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            const sep = buffer.indexOf('\r\n\r\n');
            if (sep === -1) return;
            const head = buffer.subarray(0, sep).toString('utf8');
            const extra = buffer.subarray(sep + 4);
            const status = Number((head.split(' ')[1] || '').trim());
            if (status !== 200) {
                fail(new Error(`代理 CONNECT 失败: ${head.split('\r\n')[0]}`));
                return;
            }
            socket.removeAllListeners('data');
            socket.setTimeout(0);
            if (extra.length) socket.unshift(extra);
            const tlsSocket = tls.connect({ socket, servername: target.hostname });
            tlsSocket.once('secureConnect', () => {
                if (settled) return;
                settled = true;
                resolve(tlsSocket);
            });
            tlsSocket.once('error', fail);
        });
    });
}

function connectSocks5(proxy, target) {
    return new Promise((resolve, reject) => {
        const proxyPort = Number(proxy.port || 1080);
        const targetPort = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
        const socket = net.connect(proxyPort, proxy.hostname);
        const user = proxy.username ? decodeURIComponent(proxy.username) : '';
        const pass = proxy.password ? decodeURIComponent(proxy.password) : '';
        let stage = 'greeting';
        let buffer = Buffer.alloc(0);
        let settled = false;

        const fail = (error) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            reject(error);
        };

        const finish = (stream) => {
            if (settled) return;
            settled = true;
            resolve(stream);
        };

        socket.setTimeout(20000, () => fail(new Error('连接 SOCKS5 代理超时')));
        socket.once('error', fail);
        socket.once('connect', () => {
            const methods = user ? [0x00, 0x02] : [0x00];
            socket.write(Buffer.from([0x05, methods.length, ...methods]));
        });

        const sendConnect = () => {
            const hostBuf = Buffer.from(target.hostname);
            const req = Buffer.alloc(7 + hostBuf.length);
            req[0] = 0x05;
            req[1] = 0x01;
            req[2] = 0x00;
            req[3] = 0x03;
            req[4] = hostBuf.length;
            hostBuf.copy(req, 5);
            req.writeUInt16BE(targetPort, 5 + hostBuf.length);
            socket.write(req);
            stage = 'connect';
            buffer = Buffer.alloc(0);
        };

        socket.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            if (stage === 'greeting') {
                if (buffer.length < 2) return;
                if (buffer[0] !== 0x05 || buffer[1] === 0xff) {
                    fail(new Error('SOCKS5 代理拒绝认证方式'));
                    return;
                }
                if (buffer[1] === 0x02) {
                    const userBuf = Buffer.from(user);
                    const passBuf = Buffer.from(pass);
                    const auth = Buffer.alloc(3 + userBuf.length + passBuf.length);
                    auth[0] = 0x01;
                    auth[1] = userBuf.length;
                    userBuf.copy(auth, 2);
                    auth[2 + userBuf.length] = passBuf.length;
                    passBuf.copy(auth, 3 + userBuf.length);
                    stage = 'auth';
                    buffer = Buffer.alloc(0);
                    socket.write(auth);
                    return;
                }
                if (buffer[1] !== 0x00) {
                    fail(new Error(`SOCKS5 握手失败，方法 ${buffer[1]}`));
                    return;
                }
                sendConnect();
                return;
            }

            if (stage === 'auth') {
                if (buffer.length < 2) return;
                if (buffer[1] !== 0x00) {
                    fail(new Error('SOCKS5 代理认证失败'));
                    return;
                }
                sendConnect();
                return;
            }

            if (buffer.length < 5 || buffer[0] !== 0x05) return;
            if (buffer[1] !== 0x00) {
                fail(new Error(`SOCKS5 连接目标失败，状态 ${buffer[1]}`));
                return;
            }
            const atyp = buffer[3];
            let headerLength = 0;
            if (atyp === 0x01) headerLength = 10;
            else if (atyp === 0x03) headerLength = 7 + buffer[4];
            else if (atyp === 0x04) headerLength = 22;
            else {
                fail(new Error(`SOCKS5 返回了未知地址类型 ${atyp}`));
                return;
            }
            if (buffer.length < headerLength) return;

            socket.removeAllListeners('data');
            socket.setTimeout(0);
            const extra = buffer.subarray(headerLength);
            if (extra.length) socket.unshift(extra);

            if (target.protocol === 'https:') {
                const tlsSocket = tls.connect({ socket, servername: target.hostname });
                tlsSocket.once('secureConnect', () => finish(tlsSocket));
                tlsSocket.once('error', fail);
                return;
            }
            finish(socket);
        });
    });
}

class ComfyUIClient {
    constructor(options = {}) {
        this.config = {
            // API配置
            serverUrl: (options.serverUrl || process.env.COMFYUI_SERVER_URL || 'http://127.0.0.1:8188').replace(/\/+$/, ''),
            proxyUrl: options.proxyUrl || process.env.COMFYUI_PROXY || '',
            apiKey: options.apiKey || process.env.COMFYUI_API_KEY || '',
            apiUser: options.apiUser || process.env.COMFYUI_API_USER || 'user',
            checkOnly: Boolean(options.checkOnly),
            clientId: options.clientId || this.generateClientId(),

            // 工作流配置
            workflowFile: options.workflowFile || null,
            workflow: options.workflow || null,
            promptNode: options.promptNode || null,
            prompt: options.prompt || null,
            negativePromptNode: options.negativePromptNode || null,
            negativePrompt: options.negativePrompt || null,
            imageNode: options.imageNode || null,
            imageFile: options.imageFile || null,
            imagePath: options.imagePath || null,
            imageNode2: options.imageNode2 || null,
            imageFile2: options.imageFile2 || null,
            imagePath2: options.imagePath2 || null,
            imageNode3: options.imageNode3 || null,
            imageFile3: options.imageFile3 || null,
            imagePath3: options.imagePath3 || null,

            // 输出配置（相对路径相对于项目根解析）
            outputDir: (() => {
                const dir = options.outputDir || path.join(projectRoot, 'work_dir', 'comfyui_output');
                return path.isAbsolute(dir) ? dir : path.join(projectRoot, dir);
            })(),
            sessionName: options.sessionName || null,

            // 其他配置
            timeout: (options.timeout || 600) * 1000, // 转换为毫秒
            pollInterval: options.pollInterval || 1000,
            retryCount: options.retryCount || 3,
            retryDelay: options.retryDelay || 2000
        };

        // 会话管理
        this.sessionDir = null;
        this.generatedFiles = [];
        this.taskStatus = 'pending';
        this.startTime = null;
        this.endTime = null;
        this.promptId = null;

        // 验证配置
        this.validateConfig();
    }

    /**
     * 生成客户端 ID
     */
    generateClientId() {
        return `client_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    }

    /**
     * 验证配置参数
     */
    validateConfig() {
        console.log('🔍 验证配置参数...');

        if (this.config.proxyUrl) {
            try {
                parseProxyUrl(this.config.proxyUrl);
            } catch (error) {
                throw new Error(`❌ 代理地址无效: ${this.config.proxyUrl}`);
            }
        }

        if (this.config.checkOnly) {
            console.log('✅ 连接检查模式');
            return;
        }

        // 验证工作流
        if (!this.config.workflowFile && !this.config.workflow) {
            throw new Error('❌ 必须提供工作流文件 (--workflow) 或工作流对象');
        }

        // 如果提供了工作流文件，加载它（支持相对路径，相对于项目根目录解析）
        if (this.config.workflowFile) {
            let workflowPath = this.config.workflowFile;
            if (!path.isAbsolute(workflowPath)) {
                workflowPath = path.join(projectRoot, workflowPath);
            }
            if (!fs.existsSync(workflowPath)) {
                throw new Error(`❌ 工作流文件不存在: ${this.config.workflowFile}`);
            }
            try {
                const workflowContent = fs.readFileSync(workflowPath, 'utf8');
                this.config.workflow = JSON.parse(workflowContent);
                this.config.workflowFile = workflowPath; // 统一为绝对路径
            } catch (error) {
                throw new Error(`❌ 无法解析工作流文件: ${error.message}`);
            }
        }

        console.log('✅ 配置验证通过');
    }

    /**
     * 初始化会话
     */
    initializeSession() {
        console.log('\n🚀 初始化生成会话...');

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        const sessionName = this.config.sessionName || `comfyui_${timestamp}`;

        this.sessionDir = path.join(this.config.outputDir, sessionName);

        // 创建输出目录
        if (!fs.existsSync(this.sessionDir)) {
            fs.mkdirSync(this.sessionDir, { recursive: true });
            console.log(`📁 创建会话目录: ${this.sessionDir}`);
        }

        // 创建会话信息文件
        const sessionInfo = {
            sessionName: sessionName,
            sessionDirectory: this.sessionDir,
            config: {
                serverUrl: this.config.serverUrl,
                proxyUrl: this.config.proxyUrl || null,
                clientId: this.config.clientId,
                workflowFile: this.config.workflowFile,
                promptNode: this.config.promptNode,
                prompt: this.config.prompt,
                negativePromptNode: this.config.negativePromptNode,
                negativePrompt: this.config.negativePrompt
            },
            createdAt: new Date().toISOString(),
            status: 'initialized'
        };

        const sessionInfoFile = path.join(this.sessionDir, 'session_info.json');
        fs.writeFileSync(sessionInfoFile, JSON.stringify(sessionInfo, null, 2));

        console.log(`✅ 会话初始化完成: ${sessionName}`);
        return this.sessionDir;
    }

    /**
     * 展开子图（Subgraph）节点为顶层节点
     * 处理 ComfyUI 工作流中的 subgraph 定义，将内部节点和连接提升到顶层
     */
    flattenSubgraphs(workflow) {
        if (!workflow.definitions || !workflow.definitions.subgraphs || !workflow.definitions.subgraphs.length) {
            return workflow;
        }

        console.log('🔄 检测到子图定义，开始展开...');

        const sgDefs = {};
        for (const sg of workflow.definitions.subgraphs) {
            sgDefs[sg.id] = sg;
        }

        let nextNodeId = 0;
        let nextLinkId = 0;
        for (const node of workflow.nodes) {
            if (node.id > nextNodeId) nextNodeId = node.id;
        }
        for (const link of workflow.links) {
            if (link[0] > nextLinkId) nextLinkId = link[0];
        }
        nextNodeId += 1000;
        nextLinkId += 1000;

        const nodesToAdd = [];
        const linksToAdd = [];
        const nodeIdsToRemove = new Set();
        const linkIdsToRemove = new Set();

        for (const wrapperNode of workflow.nodes) {
            const sgDef = sgDefs[wrapperNode.type];
            if (!sgDef) continue;

            console.log(`📦 展开子图节点 ${wrapperNode.id} (${sgDef.name || wrapperNode.type.substring(0, 8)}...)`);

            const nodeIdMap = {};
            const linkIdMap = {};
            const getNodeId = (oldId) => {
                if (nodeIdMap[oldId] === undefined) nodeIdMap[oldId] = nextNodeId++;
                return nodeIdMap[oldId];
            };
            const getLinkId = (oldId) => {
                if (linkIdMap[oldId] === undefined) linkIdMap[oldId] = nextLinkId++;
                return linkIdMap[oldId];
            };

            const inputLinks = {};
            const outputLinks = {};
            const internalLinks = [];

            for (const link of sgDef.links) {
                if (link.origin_id === -10) {
                    inputLinks[link.id] = link;
                } else if (link.target_id === -20) {
                    outputLinks[link.id] = link;
                } else {
                    internalLinks.push(link);
                }
            }

            const skipTypes = new Set(['MarkdownNote', 'Note', 'NoteText']);

            for (const intNode of sgDef.nodes) {
                if (skipTypes.has(intNode.type)) continue;

                const newNode = JSON.parse(JSON.stringify(intNode));
                newNode.id = getNodeId(intNode.id);

                if (newNode.inputs) {
                    for (const inp of newNode.inputs) {
                        if (inp.link != null && inputLinks[inp.link]) {
                            inp.link = null;
                        } else if (inp.link != null) {
                            inp.link = getLinkId(inp.link);
                        }
                    }
                }

                if (newNode.outputs) {
                    for (const out of newNode.outputs) {
                        if (out.links && Array.isArray(out.links)) {
                            out.links = out.links
                                .filter(lid => !outputLinks[lid])
                                .map(lid => getLinkId(lid));
                        }
                    }
                }

                nodesToAdd.push(newNode);
            }

            for (const link of internalLinks) {
                linksToAdd.push([
                    getLinkId(link.id),
                    getNodeId(link.origin_id),
                    link.origin_slot,
                    getNodeId(link.target_id),
                    link.target_slot,
                    link.type
                ]);
            }

            for (let i = 0; i < (sgDef.inputs || []).length; i++) {
                const sgInput = sgDef.inputs[i];
                const outerInput = wrapperNode.inputs && wrapperNode.inputs[i];
                if (!outerInput || outerInput.link == null) continue;

                const outerLink = workflow.links.find(l => l[0] === outerInput.link);
                if (!outerLink) continue;

                const srcNodeId = outerLink[1];
                const srcSlot = outerLink[2];

                for (const intLinkId of (sgInput.linkIds || [])) {
                    const intLink = inputLinks[intLinkId];
                    if (!intLink) continue;

                    const tgtNodeId = getNodeId(intLink.target_id);
                    const tgtSlot = intLink.target_slot;
                    const newLinkId = nextLinkId++;

                    linksToAdd.push([newLinkId, srcNodeId, srcSlot, tgtNodeId, tgtSlot, intLink.type]);

                    const tgtNode = nodesToAdd.find(n => n.id === tgtNodeId);
                    if (tgtNode && tgtNode.inputs && tgtNode.inputs[tgtSlot]) {
                        tgtNode.inputs[tgtSlot].link = newLinkId;
                    }
                }

                linkIdsToRemove.add(outerInput.link);
            }

            for (let i = 0; i < (sgDef.outputs || []).length; i++) {
                const sgOutput = sgDef.outputs[i];
                const outerOutput = wrapperNode.outputs && wrapperNode.outputs[i];
                if (!outerOutput || !outerOutput.links || !outerOutput.links.length) continue;

                for (const intLinkId of (sgOutput.linkIds || [])) {
                    const intLink = outputLinks[intLinkId];
                    if (!intLink) continue;

                    const srcNodeId = getNodeId(intLink.origin_id);
                    const srcSlot = intLink.origin_slot;
                    const srcNode = nodesToAdd.find(n => n.id === srcNodeId);

                    for (const outerLinkId of outerOutput.links) {
                        const outerLink = workflow.links.find(l => l[0] === outerLinkId);
                        if (!outerLink) continue;

                        const tgtNodeId = outerLink[3];
                        const tgtSlot = outerLink[4];
                        const newLinkId = nextLinkId++;

                        linksToAdd.push([newLinkId, srcNodeId, srcSlot, tgtNodeId, tgtSlot, intLink.type]);

                        const tgtNode = workflow.nodes.find(n => n.id === tgtNodeId);
                        if (tgtNode && tgtNode.inputs) {
                            for (const inp of tgtNode.inputs) {
                                if (inp.link === outerLinkId) {
                                    inp.link = newLinkId;
                                    break;
                                }
                            }
                        }

                        if (srcNode && srcNode.outputs) {
                            const outDef = srcNode.outputs[srcSlot];
                            if (outDef) {
                                if (!outDef.links) outDef.links = [];
                                outDef.links.push(newLinkId);
                            }
                        }

                        linkIdsToRemove.add(outerLinkId);
                    }
                }
            }

            nodeIdsToRemove.add(wrapperNode.id);
        }

        workflow.nodes = workflow.nodes.filter(n => !nodeIdsToRemove.has(n.id));
        workflow.nodes.push(...nodesToAdd);
        workflow.links = workflow.links.filter(l => !linkIdsToRemove.has(l[0]));
        workflow.links.push(...linksToAdd);
        delete workflow.definitions;

        console.log(`✅ 子图展开完成：添加 ${nodesToAdd.length} 个节点，${linksToAdd.length} 条连接`);
        return workflow;
    }

    /**
     * 处理禁用/旁路节点
     * mode=4（旁路）：透传第一个输入到所有输出
     * mode=2（静音）：移除节点和所有连接
     */
    handleBypassedNodes(workflow) {
        if (!workflow.nodes || !workflow.links) return workflow;

        const bypassedNodes = workflow.nodes.filter(n => n.mode === 4);
        const mutedNodes = workflow.nodes.filter(n => n.mode === 2);

        if (bypassedNodes.length === 0 && mutedNodes.length === 0) return workflow;

        console.log(`🔄 处理特殊模式节点: ${bypassedNodes.length} 个旁路, ${mutedNodes.length} 个静音`);

        const nodeIdsToRemove = new Set();
        const linkIdsToRemove = new Set();
        const linksToAdd = [];
        let nextLinkId = 0;
        for (const link of workflow.links) {
            if (link[0] > nextLinkId) nextLinkId = link[0];
        }
        nextLinkId += 5000;

        for (const node of bypassedNodes) {
            console.log(`  ⏭️  旁路节点 ${node.id} (${node.type})`);
            nodeIdsToRemove.add(node.id);

            let srcNodeId = null, srcSlot = null, srcType = null;

            if (node.inputs) {
                for (const inp of node.inputs) {
                    if (inp.link != null) {
                        const link = workflow.links.find(l => l[0] === inp.link);
                        if (link && srcNodeId === null) {
                            srcNodeId = link[1];
                            srcSlot = link[2];
                            srcType = link[5];
                        }
                        linkIdsToRemove.add(inp.link);
                    }
                }
            }

            const allOutputLinkIds = [];
            if (node.outputs) {
                for (const out of node.outputs) {
                    if (out.links) {
                        for (const lid of out.links) allOutputLinkIds.push(lid);
                    }
                }
            }

            if (srcNodeId !== null) {
                for (const outLinkId of allOutputLinkIds) {
                    const outLink = workflow.links.find(l => l[0] === outLinkId);
                    if (!outLink) continue;

                    const tgtNodeId = outLink[3];
                    const tgtSlot = outLink[4];
                    const newLinkId = nextLinkId++;

                    linksToAdd.push([newLinkId, srcNodeId, srcSlot, tgtNodeId, tgtSlot, srcType]);

                    const tgtNode = workflow.nodes.find(n => n.id === tgtNodeId);
                    if (tgtNode && tgtNode.inputs) {
                        for (const inp of tgtNode.inputs) {
                            if (inp.link === outLinkId) {
                                inp.link = newLinkId;
                                break;
                            }
                        }
                    }

                    linkIdsToRemove.add(outLinkId);
                }
                console.log(`    → 透传: 节点 ${srcNodeId} 直连下游`);
            } else {
                for (const outLinkId of allOutputLinkIds) {
                    const outLink = workflow.links.find(l => l[0] === outLinkId);
                    if (outLink) {
                        const tgtNode = workflow.nodes.find(n => n.id === outLink[3]);
                        if (tgtNode && tgtNode.inputs) {
                            for (const inp of tgtNode.inputs) {
                                if (inp.link === outLinkId) {
                                    inp.link = null;
                                    break;
                                }
                            }
                        }
                    }
                    linkIdsToRemove.add(outLinkId);
                }
                console.log(`    → 移除: 无输入源，断开下游连接`);
            }
        }

        for (const node of mutedNodes) {
            console.log(`  🔇 静音节点 ${node.id} (${node.type})`);
            nodeIdsToRemove.add(node.id);
            if (node.inputs) {
                for (const inp of node.inputs) {
                    if (inp.link != null) linkIdsToRemove.add(inp.link);
                }
            }
            if (node.outputs) {
                for (const out of node.outputs) {
                    if (out.links) out.links.forEach(lid => linkIdsToRemove.add(lid));
                }
            }
        }

        workflow.nodes = workflow.nodes.filter(n => !nodeIdsToRemove.has(n.id));
        workflow.links = workflow.links.filter(l => !linkIdsToRemove.has(l[0]));
        workflow.links.push(...linksToAdd);

        console.log(`✅ 特殊模式节点处理完成：移除 ${nodeIdsToRemove.size} 个节点`);
        return workflow;
    }

    /**
     * 转换工作流格式：从 ComfyUI 完整格式（nodes 数组）转换为 API 格式
     */
    convertWorkflowToApiFormat(workflow) {
        // 检查是否已经是 API 格式（直接以节点 ID 为 key）
        if (workflow.nodes === undefined && typeof workflow === 'object') {
            const firstKey = Object.keys(workflow)[0];
            if (firstKey && /^\d+$/.test(firstKey)) {
                console.log('✅ 工作流已经是 API 格式');
                return workflow;
            }
        }

        if (workflow.nodes && Array.isArray(workflow.nodes)) {
            console.log('🔄 转换工作流格式：从完整格式转换为 API 格式...');

            const nonExecutableNodeTypes = ['MarkdownNote', 'Note', 'NoteText'];
            const apiWorkflow = {};

            for (const node of workflow.nodes) {
                if (nonExecutableNodeTypes.includes(node.type)) {
                    console.log(`⏭️  跳过非执行节点: ${node.type} (ID: ${node.id})`);
                    continue;
                }
                const nodeId = String(node.id);
                const nodeData = {
                    class_type: node.type,
                    inputs: {}
                };

                if (node.title) {
                    nodeData._title = node.title;
                }

                if (node.inputs) {
                    for (const input of node.inputs) {
                        if (input.link !== null) {
                            const link = workflow.links.find(l => l[0] === input.link && l[3] === node.id);
                            if (link) {
                                const [linkId, sourceNodeId, sourceSlot, targetNodeId, targetSlot, dataType] = link;
                                nodeData.inputs[input.name] = [String(sourceNodeId), sourceSlot];
                            } else {
                                console.warn(`⚠️  节点 ${nodeId} 的输入 "${input.name}" 找不到对应的 link (linkId: ${input.link})`);
                            }
                        }
                    }
                }

                if (node.widgets_values && Array.isArray(node.widgets_values)) {
                    this.mapWidgetValues(node, nodeData);
                }

                apiWorkflow[nodeId] = nodeData;
            }

            this.cleanupWorkflowValues(apiWorkflow);
            console.log(`✅ 已转换 ${Object.keys(apiWorkflow).length} 个节点`);
            return apiWorkflow;
        }

        console.warn('⚠️  无法识别工作流格式，使用原格式');
        return workflow;
    }

    /**
     * 映射 widget values 到节点输入
     */
    mapWidgetValues(node, nodeData) {
        const widgets_values = node.widgets_values;

        const widgetMappings = {
            'KSampler': {
                values: ['seed', '_control_after_generate', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'],
                skipFields: ['_control_after_generate']
            },
            'KSamplerAdvanced': {
                values: ['add_noise', 'noise_seed', '_control_after_generate', 'steps', 'cfg', 'sampler_name', 'scheduler', 'start_at_step', 'end_at_step', 'return_with_leftover_noise'],
                skipFields: ['_control_after_generate']
            },
            'CLIPTextEncode': { values: ['text'] },
            'EmptySD3LatentImage': { values: ['width', 'height', 'batch_size'] },
            'EmptyLatentImage': { values: ['width', 'height', 'batch_size'] },
            'CLIPLoader': { values: ['clip_name', 'type', 'device'] },
            'VAELoader': { values: ['vae_name'] },
            'UNETLoader': { values: ['unet_name', 'weight_dtype'] },
            'CheckpointLoaderSimple': { values: ['ckpt_name'] },
            'SaveImage': { values: ['filename_prefix'] },
            'ModelSamplingAuraFlow': { values: ['shift'] },
            'ConditioningZeroOut': { values: [] },
            'VAEDecode': { values: [] },
            'VAEEncode': { values: [] },
            'PreviewImage': { values: [] },
            'GetImageSize': { values: [] },
            'TextEncodeQwenImageEditPlus': { values: ['prompt'] },
            'FluxKontextMultiReferenceLatentMethod': { values: ['reference_latents_method'] },
            'CFGNorm': { values: ['strength'] },
            'LoraLoaderModelOnly': { values: ['lora_name', 'strength_model'] },
            'ImageScaleToTotalPixels': { values: ['upscale_method', 'megapixels', 'rounding'] },
            'ImageScaleToMaxDimension': { values: ['upscale_method', 'largest_size'] },
            'ModelPatchLoader': { values: ['name'] },
            'QwenImageDiffsynthControlnet': { values: ['strength'] },
            'Canny': { values: ['low_threshold', 'high_threshold'] },
            'LoadImage': { values: ['image', '_upload'], skipFields: ['_upload'] }
        };

        const mapping = widgetMappings[node.type];

        if (mapping) {
            const skipFields = mapping.skipFields || [];
            let valueIndex = 0;

            for (const fieldName of mapping.values) {
                if (valueIndex >= widgets_values.length) break;

                if (skipFields.includes(fieldName) || fieldName.startsWith('_')) {
                    valueIndex++;
                    continue;
                }

                nodeData.inputs[fieldName] = widgets_values[valueIndex];
                valueIndex++;
            }
        } else {
            if (node.inputs) {
                let widgetIndex = 0;
                for (const input of node.inputs) {
                    if (input.link === null && input.widget) {
                        if (widgetIndex < widgets_values.length) {
                            nodeData.inputs[input.name] = widgets_values[widgetIndex];
                            widgetIndex++;
                        }
                    }
                }

                if (widgetIndex < widgets_values.length && node.type === 'CLIPTextEncode') {
                    if (!nodeData.inputs.text && widgets_values.length > 0) {
                        nodeData.inputs.text = widgets_values[0];
                    }
                }
            } else {
                if (node.type === 'CLIPTextEncode' && widgets_values.length > 0) {
                    nodeData.inputs.text = widgets_values[0];
                }
            }
        }
    }

    /**
     * 清理和修复工作流中的特殊值
     */
    cleanupWorkflowValues(workflow) {
        for (const [nodeId, nodeData] of Object.entries(workflow)) {
            if (nodeData.class_type === 'KSampler' || nodeData.class_type === 'KSamplerAdvanced') {
                if (typeof nodeData.inputs.steps !== 'number') {
                    console.log(`⚠️  节点 ${nodeId} 的 steps "${nodeData.inputs.steps}" 不是数字，使用默认值 20`);
                    nodeData.inputs.steps = 20;
                }

                if (typeof nodeData.inputs.cfg !== 'number') {
                    console.log(`⚠️  节点 ${nodeId} 的 cfg "${nodeData.inputs.cfg}" 不是数字，使用默认值 7`);
                    nodeData.inputs.cfg = 7;
                }

                if (typeof nodeData.inputs.sampler_name === 'number') {
                    const samplerNames = ['euler', 'euler_ancestral', 'heun', 'dpm_2', 'dpm_2_ancestral', 'lms', 'dpm_fast', 'dpm_adaptive', 'dpmpp_2s_ancestral', 'dpmpp_2m', 'dpmpp_sde', 'ddim', 'uni_pc', 'uni_pc_bh2'];
                    if (nodeData.inputs.sampler_name >= 0 && nodeData.inputs.sampler_name < samplerNames.length) {
                        nodeData.inputs.sampler_name = samplerNames[nodeData.inputs.sampler_name];
                    } else {
                        nodeData.inputs.sampler_name = 'euler';
                    }
                }

                if (typeof nodeData.inputs.denoise !== 'number') {
                    console.log(`⚠️  节点 ${nodeId} 的 denoise "${nodeData.inputs.denoise}" 不是数字，使用默认值 1.0`);
                    nodeData.inputs.denoise = 1.0;
                }

                if (typeof nodeData.inputs.seed !== 'number') {
                    console.log(`⚠️  节点 ${nodeId} 的 seed "${nodeData.inputs.seed}" 不是数字，使用随机值`);
                    nodeData.inputs.seed = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
                }
            }
        }
    }

    /**
     * 修改工作流中的 prompt
     */
    modifyWorkflowPrompt(workflow, nodeId, promptText) {
        if (!nodeId || !promptText) return workflow;

        console.log(`📝 修改节点 ${nodeId} 的 prompt: ${promptText.substring(0, 50)}...`);

        const nodeIdStr = String(nodeId);

        if (workflow[nodeIdStr] && workflow[nodeIdStr].inputs) {
            const promptFields = ['text', 'prompt', 'positive', 'negative'];
            let modified = false;

            for (const field of promptFields) {
                if (workflow[nodeIdStr].inputs.hasOwnProperty(field)) {
                    workflow[nodeIdStr].inputs[field] = promptText;
                    modified = true;
                    console.log(`✅ 已更新字段 "${field}"`);
                    break;
                }
            }

            if (!modified) {
                workflow[nodeIdStr].inputs.text = promptText;
                console.log(`✅ 已添加新字段 "text"`);
            }
        } else {
            console.warn(`⚠️  节点 ${nodeIdStr} 不存在或没有 inputs，跳过修改`);
            console.warn(`   可用节点: ${Object.keys(workflow).join(', ')}`);
        }

        return workflow;
    }

    /**
     * 修改工作流中的图片节点（LoadImage）
     */
    modifyWorkflowImage(workflow, nodeId, imageName) {
        if (!nodeId || !imageName) return workflow;

        const nodeIdStr = String(nodeId);
        console.log(`🖼️  修改节点 ${nodeIdStr} 的图片: ${imageName}`);

        if (workflow[nodeIdStr] && workflow[nodeIdStr].inputs) {
            workflow[nodeIdStr].inputs.image = imageName;
            console.log(`✅ 已更新图片为 "${imageName}"`);
        } else {
            console.warn(`⚠️  节点 ${nodeIdStr} 不存在，跳过图片修改`);
        }

        return workflow;
    }

    /**
     * 拼出带服务前缀的 API 地址
     */
    apiPath(suffix) {
        const pathPart = suffix.startsWith('/') ? suffix : `/${suffix}`;
        return `${this.config.serverUrl}${pathPart}`;
    }

    /**
     * 网关 Basic 认证：用户名任意，密码为 API Key
     */
    buildHeaders(extra = {}) {
        const headers = { ...extra };
        const hasAuth = headers.Authorization || headers.authorization;
        if (this.config.apiKey && !hasAuth) {
            const token = Buffer.from(`${this.config.apiUser}:${this.config.apiKey}`).toString('base64');
            headers.Authorization = `Basic ${token}`;
        }
        return headers;
    }

    /**
     * 创建已接好代理的 HTTP 请求
     */
    async createRequest(targetUrl, { method, headers }) {
        const target = new URL(targetUrl);
        const requestPath = `${target.pathname}${target.search}`;
        const port = target.port || (target.protocol === 'https:' ? 443 : 80);
        const proxy = parseProxyUrl(this.config.proxyUrl);

        if (!proxy) {
            const httpModule = target.protocol === 'https:' ? https : http;
            return httpModule.request({
                hostname: target.hostname,
                port,
                path: requestPath,
                method,
                headers
            });
        }

        if (proxy.protocol === 'http:' && target.protocol === 'http:') {
            const proxyHeaders = {
                ...headers,
                Host: headers.Host || headers.host || target.host
            };
            const auth = proxyBasicAuthHeader(proxy);
            if (auth) proxyHeaders['Proxy-Authorization'] = auth;
            return http.request({
                hostname: proxy.hostname,
                port: proxy.port || 80,
                method,
                path: target.href,
                headers: proxyHeaders
            });
        }

        let socket;
        if (proxy.protocol === 'http:' && target.protocol === 'https:') {
            socket = await connectHttpProxyTunnel(proxy, target);
        } else if (proxy.protocol === 'socks5:' || proxy.protocol === 'socks:') {
            socket = await connectSocks5(proxy, target);
        } else {
            throw new Error(`不支持的代理协议: ${proxy.protocol}（可用 http:// 或 socks5://）`);
        }

        return http.request({
            hostname: target.hostname,
            port,
            path: requestPath,
            method,
            headers,
            agent: false,
            createConnection: () => socket
        });
    }

    /**
     * 发出请求并返回响应流
     */
    openResponse(url, options = {}) {
        return new Promise((resolve, reject) => {
            const headers = this.buildHeaders({ ...options.headers });
            const hasContentType = headers['Content-Type'] || headers['content-type'];
            const body = options.body;
            let payload = null;

            if (body != null) {
                payload = Buffer.isBuffer(body)
                    ? body
                    : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
                if (!hasContentType && !Buffer.isBuffer(body) && typeof body !== 'string') {
                    headers['Content-Type'] = 'application/json';
                }
                if (headers['Content-Length'] == null && headers['content-length'] == null) {
                    headers['Content-Length'] = payload.length;
                }
            }

            this.createRequest(url, {
                method: options.method || 'GET',
                headers
            }).then((req) => {
                req.setTimeout(this.config.timeout, () => {
                    req.destroy(new Error('请求超时'));
                });
                req.on('error', reject);
                req.on('response', resolve);
                if (payload) req.write(payload);
                req.end();
            }).catch(reject);
        });
    }

    /**
     * 发送 HTTP 请求
     */
    async httpRequest(url, options = {}) {
        const res = await this.openResponse(url, options);
        const chunks = [];
        for await (const chunk of res) chunks.push(chunk);
        const data = Buffer.concat(chunks).toString('utf8');
        let parsed = data;
        if (res.statusCode >= 200 && res.statusCode < 300 && data) {
            try {
                parsed = JSON.parse(data);
            } catch (error) {
                parsed = data;
            }
        }
        return {
            statusCode: res.statusCode,
            headers: res.headers,
            data: parsed
        };
    }

    /**
     * 检查代理、网关认证和远端 ComfyUI 是否可用
     */
    async checkConnection() {
        const proxy = this.config.proxyUrl || '未使用';
        console.log(`\n🌐 服务器: ${this.config.serverUrl}`);
        console.log(`🔀 代理: ${proxy}`);

        const stats = await this.httpRequest(this.apiPath('/system_stats'));
        if (stats.statusCode !== 200 || !stats.data || !stats.data.system) {
            const detail = typeof stats.data === 'string' ? stats.data.slice(0, 200) : JSON.stringify(stats.data);
            throw new Error(`system_stats 返回 ${stats.statusCode}: ${detail}`);
        }

        const queue = await this.httpRequest(this.apiPath('/queue'));
        if (queue.statusCode !== 200) {
            throw new Error(`queue 返回 ${queue.statusCode}`);
        }

        const system = stats.data.system;
        const device = Array.isArray(stats.data.devices) && stats.data.devices[0]
            ? stats.data.devices[0].name
            : '未知设备';
        const running = Array.isArray(queue.data.queue_running) ? queue.data.queue_running.length : 0;
        const pending = Array.isArray(queue.data.queue_pending) ? queue.data.queue_pending.length : 0;

        console.log(`✅ ComfyUI ${system.comfyui_version}（${system.os}）`);
        console.log(`✅ 设备: ${device}`);
        console.log(`✅ 队列: 运行中 ${running}，等待中 ${pending}`);
        return {
            version: system.comfyui_version,
            os: system.os,
            device,
            queueRunning: running,
            queuePending: pending
        };
    }

    /**
     * 上传图片到 ComfyUI input 目录
     * @param {string} imagePath - 本地图片路径
     * @param {string} [targetName] - 可选，上传后的目标文件名（用于 overwrite）
     * @returns {Promise<string>} - 上传后的文件名
     */
    async uploadImageToComfyUI(imagePath, targetName) {
        const absPath = path.isAbsolute(imagePath) ? imagePath : path.join(projectRoot, imagePath);
        if (!fs.existsSync(absPath)) {
            throw new Error(`图片文件不存在: ${absPath}`);
        }

        console.log(`📤 上传图片到 ComfyUI: ${path.basename(absPath)}`);

        const imageBuffer = fs.readFileSync(absPath);
        const filename = targetName || path.basename(absPath);
        const ext = path.extname(absPath).toLowerCase();

        const contentTypes = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.webp': 'image/webp'
        };
        const contentType = contentTypes[ext] || 'image/png';

        const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
        const body = Buffer.concat([
            Buffer.from(`--${boundary}\r\n`),
            Buffer.from(`Content-Disposition: form-data; name="image"; filename="${filename}"\r\n`),
            Buffer.from(`Content-Type: ${contentType}\r\n\r\n`),
            imageBuffer,
            Buffer.from(`\r\n--${boundary}\r\n`),
            Buffer.from(`Content-Disposition: form-data; name="overwrite"\r\n\r\n`),
            Buffer.from('true'),
            Buffer.from(`\r\n--${boundary}--\r\n`)
        ]);

        try {
            const response = await this.httpRequest(this.apiPath('/upload/image'), {
                method: 'POST',
                headers: {
                    'Content-Type': `multipart/form-data; boundary=${boundary}`
                },
                body
            });
            const result = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
            if (result && result.name) {
                console.log(`✅ 图片上传成功: ${result.name}`);
                return result.name;
            }
            throw new Error(`上传响应无效: ${JSON.stringify(response.data)}`);
        } catch (error) {
            throw new Error(`上传失败: ${error.message}`);
        }
    }

    /**
     * 提交工作流到队列
     */
    async queuePrompt(workflow) {
        console.log('\n📤 提交工作流到队列...');

        const url = this.apiPath('/prompt');
        const payload = {
            prompt: workflow,
            client_id: this.config.clientId
        };

        try {
            const response = await this.httpRequest(url, {
                method: 'POST',
                body: payload
            });

            if (response.statusCode !== 200) {
                throw new Error(`API 返回错误: ${response.statusCode} - ${JSON.stringify(response.data)}`);
            }

            const result = response.data;
            if (result.error) {
                throw new Error(`工作流错误: ${JSON.stringify(result.error)}`);
            }

            this.promptId = result.prompt_id;
            console.log(`✅ 工作流已提交，Prompt ID: ${this.promptId}`);

            return result;
        } catch (error) {
            throw new Error(`提交工作流失败: ${error.message}`);
        }
    }

    /**
     * 查询队列状态
     */
    async getQueueStatus() {
        try {
            const url = this.apiPath('/queue');
            const response = await this.httpRequest(url);
            if (response.statusCode !== 200) {
                throw new Error(`查询队列失败: ${response.statusCode}`);
            }
            return response.data;
        } catch (error) {
            throw new Error(`查询队列状态失败: ${error.message}`);
        }
    }

    /**
     * 获取历史记录
     */
    async getHistory(maxItems = 1) {
        try {
            const url = this.apiPath(`/history/${this.promptId || ''}`);
            const response = await this.httpRequest(url);
            if (response.statusCode !== 200) {
                throw new Error(`获取历史失败: ${response.statusCode}`);
            }
            return response.data;
        } catch (error) {
            throw new Error(`获取历史记录失败: ${error.message}`);
        }
    }

    /**
     * 下载文件
     */
    async downloadFile(url, outputPath) {
        const response = await this.openResponse(url, { method: 'GET' });
        if (response.statusCode !== 200) {
            response.resume();
            throw new Error(`下载失败: ${response.statusCode}`);
        }

        await new Promise((resolve, reject) => {
            const file = fs.createWriteStream(outputPath);
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve();
            });
            file.on('error', reject);
            response.on('error', reject);
        });
        return outputPath;
    }

    /**
     * 获取生成的图片/视频
     */
    async fetchOutputs(history) {
        console.log('\n📥 获取生成结果...');

        const outputs = [];
        const videoExts = ['.mp4', '.webm', '.gif', '.mov', '.avi', '.mkv'];

        for (const [promptId, promptData] of Object.entries(history)) {
            if (!promptData.outputs) continue;

            for (const [nodeId, nodeOutput] of Object.entries(promptData.outputs)) {
                if (!nodeOutput.images) continue;

                for (const image of nodeOutput.images) {
                    const filename = image.filename || image.name || '';
                    const fileExt = path.extname(filename).toLowerCase();
                    const subfolder = image.subfolder || '';
                    const type = image.type || 'output';
                    const viewUrl = this.apiPath(`/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`);
                    const outputFilename = `${nodeId}_${filename}`;
                    const outputPath = path.join(this.sessionDir, outputFilename);

                    try {
                        if (videoExts.includes(fileExt)) {
                            console.log(`⬇️  下载视频: ${filename}`);
                        } else {
                            console.log(`⬇️  下载: ${filename}`);
                        }
                        await this.downloadFile(viewUrl, outputPath);
                        outputs.push({
                            nodeId: nodeId,
                            filename: filename,
                            localPath: outputPath,
                            url: viewUrl
                        });
                        console.log(`✅ 已保存: ${outputPath}`);
                    } catch (error) {
                        console.error(`❌ 下载失败 ${filename}: ${error.message}`);
                    }
                }
            }
        }

        return outputs;
    }

    /**
     * 等待任务完成
     */
    async waitForCompletion() {
        console.log('\n⏳ 等待任务完成...');

        const startTime = Date.now();
        let lastStatus = null;
        let hasOutput = false;

        while (Date.now() - startTime < this.config.timeout) {
            try {
                const history = await this.getHistory();

                if (history[this.promptId]) {
                    const promptData = history[this.promptId];

                    if (promptData.outputs && Object.keys(promptData.outputs).length > 0) {
                        let hasFiles = false;
                        for (const [nodeId, nodeOutput] of Object.entries(promptData.outputs)) {
                            if (nodeOutput.images && nodeOutput.images.length > 0) {
                                hasFiles = true;
                                break;
                            }
                        }

                        if (hasFiles) {
                            console.log('✅ 检测到输出文件，任务完成');
                            return promptData;
                        }
                    }

                    if (promptData.status && promptData.status.completed) {
                        if (promptData.outputs && Object.keys(promptData.outputs).length > 0) {
                            console.log('✅ 任务已完成（有输出）');
                            return promptData;
                        } else {
                            if (!hasOutput) {
                                console.log('⏳ 任务标记完成但尚未有输出，继续等待...');
                                hasOutput = true;
                            }
                        }
                    }
                }

                const queueStatus = await this.getQueueStatus();
                const currentStatus = JSON.stringify(queueStatus);

                if (currentStatus !== lastStatus) {
                    console.log(`📊 队列状态: ${JSON.stringify(queueStatus).substring(0, 100)}...`);
                    lastStatus = currentStatus;
                }

                await new Promise(resolve => setTimeout(resolve, this.config.pollInterval));

            } catch (error) {
                console.warn(`⚠️  轮询错误: ${error.message}`);
                await new Promise(resolve => setTimeout(resolve, this.config.pollInterval));
            }
        }

        throw new Error(`任务超时 (${this.config.timeout / 1000}秒)`);
    }

    /**
     * 执行工作流
     */
    async execute() {
        try {
            this.startTime = Date.now();
            this.taskStatus = 'running';

            this.initializeSession();

            let workflow = JSON.parse(JSON.stringify(this.config.workflow));
            workflow = this.flattenSubgraphs(workflow);
            workflow = this.handleBypassedNodes(workflow);
            workflow = this.convertWorkflowToApiFormat(workflow);

            if (this.config.promptNode && this.config.prompt) {
                workflow = this.modifyWorkflowPrompt(workflow, this.config.promptNode, this.config.prompt);
            } else if (this.config.prompt) {
                const promptNodeTypes = ['CLIPTextEncode', 'TextEncodeQwenImageEditPlus'];
                console.log(`🔍 自动查找 prompt 节点 (${promptNodeTypes.join(', ')})...`);
                let found = false;
                let candidateNodes = [];
                for (const [nodeId, nodeData] of Object.entries(workflow)) {
                    if (promptNodeTypes.includes(nodeData.class_type)) {
                        if (nodeData.class_type === 'TextEncodeQwenImageEditPlus') {
                            const hasPrompt = nodeData.inputs && typeof nodeData.inputs.prompt === 'string' && nodeData.inputs.prompt.length > 0;
                            const isPositive = nodeData._title && nodeData._title.toLowerCase().includes('positive');
                            if (!hasPrompt && !isPositive) continue;
                        }
                        if (nodeData.class_type === 'CLIPTextEncode') {
                            const titleLower = (nodeData._title || '').toLowerCase();
                            if (titleLower.includes('negative')) continue;
                            const isPositive = titleLower.includes('positive');
                            candidateNodes.push({ nodeId, nodeData, isPositive });
                            continue;
                        }
                        candidateNodes.push({ nodeId, nodeData, isPositive: false });
                    }
                }
                if (candidateNodes.length > 0) {
                    const positiveNode = candidateNodes.find(n => n.isPositive);
                    const target = positiveNode || candidateNodes[0];
                    console.log(`✅ 找到 ${target.nodeData.class_type} 节点: ${target.nodeId}${target.isPositive ? ' (Positive)' : ''}`);
                    workflow = this.modifyWorkflowPrompt(workflow, target.nodeId, this.config.prompt);
                    found = true;
                }
                if (!found) {
                    console.warn('⚠️  未找到可注入 prompt 的节点');
                }
            }

            // 注入 negative prompt
            if (this.config.negativePromptNode && this.config.negativePrompt) {
                workflow = this.modifyWorkflowPrompt(workflow, this.config.negativePromptNode, this.config.negativePrompt);
                console.log(`✅ 已设置 negative prompt 到节点: ${this.config.negativePromptNode}`);
            } else if (this.config.negativePrompt) {
                console.log('🔍 自动查找 negative prompt 节点...');
                let negFound = false;
                for (const [nodeId, nodeData] of Object.entries(workflow)) {
                    if (nodeData.class_type === 'CLIPTextEncode') {
                        const titleLower = (nodeData._title || '').toLowerCase();
                        if (titleLower.includes('negative')) {
                            console.log(`✅ 找到 Negative Prompt 节点: ${nodeId}`);
                            workflow = this.modifyWorkflowPrompt(workflow, nodeId, this.config.negativePrompt);
                            negFound = true;
                            break;
                        }
                    }
                }
                if (!negFound) {
                    console.warn('⚠️  未找到 negative prompt 节点，忽略 --negative-prompt');
                }
            }

            // 若提供 --image-path，先上传到 ComfyUI 再使用
            let imageFile = this.config.imageFile;
            let imageFile2 = this.config.imageFile2;
            let imageFile3 = this.config.imageFile3;
            if (this.config.imagePath && this.config.imageNode) {
                imageFile = await this.uploadImageToComfyUI(this.config.imagePath, this.config.imageFile || undefined);
            }
            if (this.config.imagePath2 && this.config.imageNode2) {
                imageFile2 = await this.uploadImageToComfyUI(this.config.imagePath2, this.config.imageFile2 || undefined);
            }
            if (this.config.imagePath3 && this.config.imageNode3) {
                imageFile3 = await this.uploadImageToComfyUI(this.config.imagePath3, this.config.imageFile3 || undefined);
            }

            if (this.config.imageNode && imageFile) {
                workflow = this.modifyWorkflowImage(workflow, this.config.imageNode, imageFile);
            }
            if (this.config.imageNode2 && imageFile2) {
                workflow = this.modifyWorkflowImage(workflow, this.config.imageNode2, imageFile2);
            }
            if (this.config.imageNode3 && imageFile3) {
                workflow = this.modifyWorkflowImage(workflow, this.config.imageNode3, imageFile3);
            }

            const workflowPath = path.join(this.sessionDir, 'workflow.json');
            fs.writeFileSync(workflowPath, JSON.stringify(workflow, null, 2));
            console.log(`💾 工作流已保存: ${workflowPath}`);

            await this.queuePrompt(workflow);
            await this.waitForCompletion();

            const history = await this.getHistory();
            this.generatedFiles = await this.fetchOutputs(history);

            this.endTime = Date.now();
            this.taskStatus = 'completed';

            const resultPath = path.join(this.sessionDir, 'result.json');
            const resultData = {
                promptId: this.promptId,
                status: this.taskStatus,
                startTime: new Date(this.startTime).toISOString(),
                endTime: new Date(this.endTime).toISOString(),
                duration: this.endTime - this.startTime,
                generatedFiles: this.generatedFiles,
                history: history
            };
            fs.writeFileSync(resultPath, JSON.stringify(resultData, null, 2));

            console.log('\n🎉 任务完成！');
            console.log(`📊 生成文件数: ${this.generatedFiles.length}`);
            console.log(`⏱️  总耗时: ${Math.round((this.endTime - this.startTime) / 1000)}秒`);
            console.log(`📁 输出目录: ${this.sessionDir}`);

            return resultData;

        } catch (error) {
            this.taskStatus = 'failed';
            this.endTime = Date.now();

            console.error(`\n❌ 任务失败: ${error.message}`);

            if (this.sessionDir) {
                const errorPath = path.join(this.sessionDir, 'error.json');
                fs.writeFileSync(errorPath, JSON.stringify({
                    error: error.message,
                    stack: error.stack,
                    timestamp: new Date().toISOString()
                }, null, 2));
            }

            throw error;
        }
    }
}

/**
 * 解析命令行参数
 */
function parseArguments() {
    const args = process.argv.slice(2);
    const options = {};

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        switch (arg) {
            case '--workflow':
                options.workflowFile = args[++i];
                break;
            case '--server':
                options.serverUrl = args[++i];
                break;
            case '--proxy':
                options.proxyUrl = args[++i];
                break;
            case '--api-key':
                options.apiKey = args[++i];
                break;
            case '--api-user':
                options.apiUser = args[++i];
                break;
            case '--check':
                options.checkOnly = true;
                break;
            case '--client-id':
                options.clientId = args[++i];
                break;
            case '--prompt-node':
                options.promptNode = args[++i];
                break;
            case '--prompt':
                options.prompt = args[++i];
                break;
            case '--negative-prompt-node':
                options.negativePromptNode = args[++i];
                break;
            case '--negative-prompt':
                options.negativePrompt = args[++i];
                break;
            case '--output-dir':
                options.outputDir = args[++i];
                break;
            case '--image-node':
                options.imageNode = args[++i];
                break;
            case '--image-file':
                options.imageFile = args[++i];
                break;
            case '--image-path':
                options.imagePath = args[++i];
                break;
            case '--image-node2':
                options.imageNode2 = args[++i];
                break;
            case '--image-file2':
                options.imageFile2 = args[++i];
                break;
            case '--image-path2':
                options.imagePath2 = args[++i];
                break;
            case '--image-node3':
                options.imageNode3 = args[++i];
                break;
            case '--image-file3':
                options.imageFile3 = args[++i];
                break;
            case '--image-path3':
                options.imagePath3 = args[++i];
                break;
            case '--session-name':
                options.sessionName = args[++i];
                break;
            case '--timeout':
                options.timeout = parseInt(args[++i]);
                break;
            case '--poll-interval':
                options.pollInterval = parseInt(args[++i]);
                break;
            case '--help':
                options.help = true;
                break;
        }
    }

    return options;
}

/**
 * 显示帮助信息
 */
function showHelp() {
    console.log(`
ComfyUI 工作流调用脚本 (comfyui-client 技能)

使用方法:
  node scripts/comfyUIClient.js [选项]
  或（技能安装路径）: node .claude/skills/comfyui-client/scripts/comfyUIClient.js [选项]

选项:
  --workflow <file>           工作流 JSON 文件路径 (必需)
  --server <url>              ComfyUI 服务器地址 (默认: http://127.0.0.1:8188，或 .env 的 COMFYUI_SERVER_URL)
  --proxy <url>               HTTP 或 SOCKS5 代理，例如 http://127.0.0.1:8080
  --api-key <key>             网关 API Key，作为 HTTP Basic 密码
  --api-user <user>           Basic 认证用户名 (默认: user，网关不校验用户名)
  --check                     只检查代理和远端 ComfyUI，不提交工作流
  --client-id <id>            客户端 ID (默认: 自动生成)
  --prompt-node <node_id>     要修改的 prompt 节点 ID (可选)
  --prompt <text>             新的 prompt 文本 (可选)
  --negative-prompt-node <id> 负面 prompt 节点 ID (可选，默认自动查找)
  --negative-prompt <text>    负面 prompt 文本 (可选)
  --image-node <node_id>      要修改的 LoadImage 节点 ID (图生图/编辑时使用)
  --image-file <filename>    已上传到 ComfyUI 的图片文件名 (或上传后的目标名)
  --image-path <path>        本地图片路径，将自动上传到 ComfyUI (与 --image-node 配合)
  --image-node2 <node_id>    第二张参考图的 LoadImage 节点 ID (多图编辑)
  --image-file2 <filename>   第二张参考图的文件名 (多图编辑)
  --image-path2 <path>       第二张图的本地路径，将自动上传
  --image-node3 <node_id>    第三张参考图的 LoadImage 节点 ID (多图编辑)
  --image-file3 <filename>   第三张参考图的文件名 (多图编辑)
  --image-path3 <path>       第三张图的本地路径，将自动上传
  --output-dir <dir>          输出目录 (默认: <项目根>/work_dir/comfyui_output)
  --session-name <name>       会话名称 (用于管理生成任务)
  --timeout <seconds>         超时时间，秒 (默认: 600)
  --poll-interval <ms>        轮询间隔，毫秒 (默认: 1000)
  --help                      显示帮助信息

环境变量（项目根目录 .env）:
  COMFYUI_SERVER_URL          ComfyUI 服务器地址，可带路径前缀
  COMFYUI_PROXY               HTTP 或 SOCKS5 代理
  COMFYUI_API_KEY             网关 API Key
  COMFYUI_API_USER            Basic 认证用户名，默认 user

示例:
  # 文生图
  node .claude/skills/comfyui-client/scripts/comfyUIClient.js --workflow .claude/skills/comfyui-client/assets/workflows/image_z_image.json --prompt "a beautiful landscape"
  # 文生图 + 负面提示词
  node .claude/skills/comfyui-client/scripts/comfyUIClient.js --workflow .claude/skills/comfyui-client/assets/workflows/image_z_image.json --prompt "a beautiful landscape" --negative-prompt "blurry, low quality, watermark"
  # ControlNet 图像编辑 (使用 --image-path 自动上传本地图片)
  node .claude/skills/comfyui-client/scripts/comfyUIClient.js --workflow .claude/skills/comfyui-client/assets/workflows/image_z_image_turbo_fun_union_controlnet.json --prompt "oil painting style" --image-node 58 --image-path "path/to/input.png"
  # Qwen 多图编辑 (需先上传图片)
  node .claude/skills/comfyui-client/scripts/comfyUIClient.js --workflow .claude/skills/comfyui-client/assets/workflows/image_qwen_image_edit_2511.json --prompt-node 68 --prompt "Change material to fur" --image-node 41 --image-file "sofa.png" --image-node2 83 --image-file2 "fur.png"
  # 视频生成
  node .claude/skills/comfyui-client/scripts/comfyUIClient.js --workflow .claude/skills/comfyui-client/assets/workflows/video_wan2_2_14B_i2v.json --prompt "镜头缓慢推进" --timeout 900
`);
}

async function main() {
    try {
        const options = parseArguments();

        if (options.help) {
            showHelp();
            process.exit(0);
        }

        if (options.checkOnly) {
            const client = new ComfyUIClient(options);
            await client.checkConnection();
            process.exit(0);
        }

        if (!options.workflowFile) {
            console.error('❌ 必须提供工作流文件 (--workflow)');
            console.error('💡 使用 --help 查看使用说明');
            process.exit(1);
        }

        const client = new ComfyUIClient(options);
        await client.execute();

        process.exit(0);

    } catch (error) {
        console.error(`\n💥 程序异常退出: ${error.message}`);
        if (error.stack) {
            console.error(error.stack);
        }
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = ComfyUIClient;
