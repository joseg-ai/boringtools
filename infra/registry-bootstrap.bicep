targetScope = 'resourceGroup'

@minLength(1)
@description('Explicit operator-selected Azure location; no subscription or region is assumed.')
param location string

@minLength(5)
@maxLength(50)
param registryName string

@minLength(3)
@maxLength(128)
param pullIdentityName string

resource registry 'Microsoft.ContainerRegistry/registries@2025-04-01' = {
  name: registryName
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
    anonymousPullEnabled: false
    publicNetworkAccess: 'Enabled'
    policies: {
      azureADAuthenticationAsArmPolicy: {
        status: 'enabled'
      }
    }
  }
}

resource pullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: pullIdentityName
  location: location
}

// Bootstrap identity before the first real image; no temporary public app is needed.
resource pullRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, pullIdentity.id, 'acrpull')
  scope: registry
  properties: {
    principalId: pullIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  }
}

output registryName string = registry.name
output registryLoginServer string = registry.properties.loginServer
output pullIdentityId string = pullIdentity.id
