targetScope = 'subscription'

param location string
param resourceGroupName string
param registryName string
param pullIdentityName string

resource group 'Microsoft.Resources/resourceGroups@2025-04-01' = {
  name: resourceGroupName
  location: location
  tags: {
    project: 'domos-tools'
    environment: 'preview'
  }
}

module bootstrap './registry-bootstrap.bicep' = {
  name: 'domos-preview-registry'
  scope: group
  params: {
    location: location
    registryName: registryName
    pullIdentityName: pullIdentityName
  }
}

output resourceGroupName string = group.name
output registryName string = bootstrap.outputs.registryName
output registryLoginServer string = bootstrap.outputs.registryLoginServer
output pullIdentityId string = bootstrap.outputs.pullIdentityId
