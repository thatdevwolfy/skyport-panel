const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const axios = require('axios');
const { db } = require('../handlers/db.js');

const saltRounds = 10;

// Middleware to check for a valid API key
async function validateApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  
  if (!apiKey) {
    return res.status(401).json({ error: 'API key is required' });
  }

  try {
    const apiKeys = await db.get('apiKeys') || [];
    const validKey = apiKeys.find(key => key.key === apiKey);

    if (!validKey) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    req.apiKey = validKey;
    next();
  } catch (error) {
    res.status(500).json({ error: 'Failed to validate API key' });
  }
}

// Users
router.get('/api/users', validateApiKey, async (req, res) => {
  try {
    const users = await db.get('users') || [];

    res.json(users);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve user' });
  }
});

router.get('/api/getUser', validateApiKey, async (req, res) => {
  try {
    const { type, value } = req.body;

    if (!type || !value) {
      return res.status(400).json({ error: 'Type and value are required' });
    }

    const users = await db.get('users') || [];
    
    let user;
    if (type === 'email') {
      user = users.find(user => user.email === value);
    } else if (type === 'username') {
      user = users.find(user => user.username === value);
    } else {
      return res.status(400).json({ error: 'Invalid search type. Use "email" or "username".' });
    }
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json(user);
  } catch (error) {
    console.error('Error retrieving user:', error);
    res.status(500).json({ error: 'Failed to retrieve user' });
  }
});

router.post('/api/users/create', validateApiKey, async (req, res) => {
  try {
    const { username, email, password, admin } = req.body;
    
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const userExists = await db.get('users').then(users => 
      users && users.some(user => user.username === username)
    );

    if (userExists) {
      return res.status(409).json({ error: 'User already exists' });
    }

    const user = {
      userId: uuidv4(),
      username,
      email,
      password: await bcrypt.hash(password, saltRounds),
      Accesto: [],
      admin: admin === true
    };

    let users = await db.get('users') || [];
    users.push(user);
    await db.set('users', users);

    res.status(201).json({ userId: user.userId, email, username: user.username, admin: user.admin });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Instance
router.get('/api/instances', validateApiKey, async (req, res) => {
  try {
    const instances = await db.get('instances') || [];
    res.json(instances);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve instances' });
  }
});

router.post('/api/instances/deploy', validateApiKey, async (req, res) => {
  const {
    image,
    memory,
    cpu,
    ports,
    nodeId,
    name,
    user,
    primary,
  } = req.body;

  if (!image || !memory || !cpu || !ports || !nodeId || !name || !user || !primary) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  const NodeId = nodeId;
  const Memory = parseInt(memory);
  const Cpu = parseInt(cpu);
  const ExposedPorts = {};
  const PortBindings = {};
  const PrimaryPort = primary;

  let rawImage = await db.get('images');
  rawImage = rawImage.find(i => i.Image === image);
  const Env = rawImage ? rawImage.Env : undefined;
  const Scripts = rawImage ? rawImage.Scripts : undefined;

  const Node = await db.get(NodeId + '_node');
  if (!Node) return res.status(400).json({ error: 'Invalid node' });

  const RequestData = {
    method: 'post',
    url: `http://${Node.address}:${Node.port}/instances/create`,
    auth: {
      username: 'Skyport',
      password: Node.apiKey
    },
    headers: { 
      'Content-Type': 'application/json'
    },
    data: {
      Name: name,
      Image: image,
      Env,
      Scripts,
      Memory,
      Cpu,
      ExposedPorts: {},
      PortBindings: {}
    }
  };

  // Process ports
  if (ports) {
    ports.split(',').forEach(portMapping => {
      const [containerPort, hostPort] = portMapping.split(':');
      const key = `${containerPort}/tcp`;
      RequestData.data.ExposedPorts[key] = {};
      RequestData.data.PortBindings[key] = [{ HostPort: hostPort }];
    });
  }

  try {
    const response = await axios(RequestData);

    // Attempt to get the user's current server list
    const userId = user;
    const userServers = await db.get(`${userId}_instances`) || [];
    const globalServers = await db.get('instances') || [];

    // Append the new server ID to the user's server list
    userServers.push({
      Name: name,
      Node,
      User: userId,
      ContainerId: response.data.containerId,
      VolumeId: response.data.volumeId,
      Memory,
      Cpu,
      Ports: ports,
      Primary: PrimaryPort,
      ExposedPorts,
      PortBindings
    });

    globalServers.push({
      Name: name,
      Node,
      User: userId,
      ContainerId: response.data.containerId,
      VolumeId: response.data.volumeId,
      Memory,
      Cpu,
      Ports: ports,
      Primary: PrimaryPort,
      ExposedPorts,
      PortBindings
    });

    // Save the updated list back to the database
    await db.set(`${userId}_instances`, userServers);
    await db.set(`instances`, globalServers);

    await db.set(`${response.data.containerId}_instance`, {
      Name: name,
      Node,
      Image: image,
      User: userId,
      ContainerId: response.data.containerId,
      VolumeId: response.data.volumeId,
      Memory,
      Cpu,
      Ports: ports,
      Primary: PrimaryPort,
      ExposedPorts,
      PortBindings
    });

    res.status(201).json({
      Message: 'Container created successfully and added to user\'s servers',
      ContainerId: response.data.containerId,
      VolumeId: response.data.volumeId
    });
  } catch (error) {
    console.log(error)
    res.status(500).json({
      error: 'Failed to create container',
      details: error.response ? error.response.data : 'No additional error info'
    });
  }
});

router.delete('/api/instance/delete', validateApiKey, async (req, res) => {
  const { id } = req.body;
  
  try {
    if (!id) {
      return res.status(400).json({ error: 'Missing ID parameter' });
    }
    
    const instance = await db.get(id + '_instance');
    if (!instance) {
      return res.status(400).json({ error: 'Instance not found' });
    }
    
    await deleteInstance(instance);
    res.status(201).json({ Message: 'The instance has successfully been deleted.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete instances' });
  }
});

router.get('/api/getInstance', validateApiKey, async (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'Parameter "userId" is required' });
  }

  try {
    const userInstances = await db.get(`${userId}_instances`) || [];
    res.json(userInstances);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve user instances' });
  }
});

// Images
router.get('/api/images', validateApiKey, async (req, res) => {
  try {
    const images = await db.get('images') || [];
    res.json(images);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve images' });
  }
});

// Nodes
router.get('/api/nodes', validateApiKey, async (req, res) => {
  try {
    const nodes = await db.get('nodes') || [];
    const nodeDetails = await Promise.all(nodes.map(id => db.get(id + '_node')));
    res.json(nodeDetails);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve nodes' });
  }
});

router.post('/api/nodes/create', validateApiKey, async (req, res) => {
  const node = {
    id: uuidv4(),
    name: req.body.name,
    tags: req.body.tags,
    ram: req.body.ram,
    disk: req.body.disk,
    processor: req.body.processor,
    address: req.body.address,
    port: req.body.port,
    apiKey: null, // Set to null initially
    configureKey: configureKey, // Add the configureKey
    status: 'Unconfigured' // Status to indicate pending configuration
  };

  if (!req.body.name || !req.body.tags || !req.body.ram || !req.body.disk || !req.body.processor || !req.body.address || !req.body.port) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  await db.set(node.id + '_node', node); // Save the initial node info
  const updatedNode = await checkNodeStatus(node); // Check and update status

  const nodes = await db.get('nodes') || [];
  nodes.push(node.id);
  await db.set('nodes', nodes);

  res.status(201).json({ Message: updatedNode });
});

router.delete('/api/nodes/delete', validateApiKey, async (req, res) => {
  const nodeId = req.body.nodeId;
  const nodes = await db.get('nodes') || [];
  const newNodes = nodes.filter(id => id !== nodeId);

  if (!nodeId) return res.send('Invalid node')

  await db.set('nodes', newNodes);
  await db.delete(nodeId + '_node');

  res.status(201).json({ Message: "The node has successfully deleted." });
});

// Function

// Helper function to delete an instance
async function deleteInstance(instance) {
  try {
    await axios.get(`http://Skyport:${instance.Node.apiKey}@${instance.Node.address}:${instance.Node.port}/instances/${instance.ContainerId}/delete`);
    
    // Update user's instances
    let userInstances = await db.get(instance.User + '_instances') || [];
    userInstances = userInstances.filter(obj => obj.ContainerId !== instance.ContainerId);
    await db.set(instance.User + '_instances', userInstances);
    
    // Update global instances
    let globalInstances = await db.get('instances') || [];
    globalInstances = globalInstances.filter(obj => obj.ContainerId !== instance.ContainerId);
    await db.set('instances', globalInstances);
    
    // Delete instance-specific data
    await db.delete(instance.ContainerId + '_instance');
  } catch (error) {
    console.error(`Error deleting instance ${instance.ContainerId}:`, error);
    throw error;
  }
}

/**
 * Checks the operational status of a node by making an HTTP request to its API.
 * Updates the node's status based on the response or sets it as 'Offline' if the request fails.
 * This status check and update are persisted in the database.
 *
 * @param {Object} node - The node object containing details such as address, port, and API key.
 * @returns {Promise<Object>} Returns the updated node object after attempting to verify its status.
 */
async function checkNodeStatus(node) {
  try {
    const RequestData = {
      method: 'get',
      url: 'http://' + node.address + ':' + node.port + '/',
      auth: {
        username: 'Skyport',
        password: node.apiKey
      },
      headers: { 
        'Content-Type': 'application/json'
      }
    };
    const response = await axios(RequestData);
    const { versionFamily, versionRelease, online, remote, docker } = response.data;

    node.status = 'Online';
    node.versionFamily = versionFamily;
    node.versionRelease = versionRelease;
    node.remote = remote;
    node.docker = docker;

    await db.set(node.id + '_node', node); // Update node info with new details
    return node;
  } catch (error) {
    node.status = 'Offline';
    await db.set(node.id + '_node', node); // Update node as offline if there's an error
    return node;
  }
}

module.exports = router;
