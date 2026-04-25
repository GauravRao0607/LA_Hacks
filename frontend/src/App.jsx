import { useState, useCallback } from 'react'
import TopBar from './components/TopBar'
import Sidebar from './components/Sidebar'
import ThreatMap from './components/Map'
import IncidentDetail from './components/IncidentDetail'
import KnowledgeGraph from './components/KnowledgeGraph'
import { useIncidents } from './hooks/useIncidents'
import './styles/App.css'

export default function App() {
  const [selectedId, setSelectedId] = useState(null)
  const [showGraph, setShowGraph] = useState(false)
  const incidents = useIncidents()
  const selectedIncident = incidents.find(i => i.id === selectedId) || null

  const handleSelect = useCallback((incident) => {
    setSelectedId(prev => (prev === incident.id ? null : incident.id))
  }, [])

  const handleClose       = useCallback(() => setSelectedId(null), [])
  const handleGraphToggle = useCallback(() => setShowGraph(v => !v), [])
  const handleGraphClose  = useCallback(() => setShowGraph(false), [])

  return (
    <div className="app">
      <ThreatMap
        incidents={incidents}
        selectedId={selectedId}
        onSelectIncident={handleSelect}
      />

      <div className="app-layout">
        <TopBar incidents={incidents} showGraph={showGraph} onGraphToggle={handleGraphToggle} />

        {showGraph ? (
          <KnowledgeGraph
            incidents={incidents}
            onClose={handleGraphClose}
            onSelectIncident={handleSelect}
          />
        ) : (
          <div className="app-content">
            <Sidebar
              incidents={incidents}
              selectedId={selectedId}
              onSelect={handleSelect}
            />
            <div style={{ flex: 1 }} />
          </div>
        )}
      </div>

      {!showGraph && selectedIncident && (
        <IncidentDetail
          incident={selectedIncident}
          onClose={handleClose}
        />
      )}
    </div>
  )
}
