export const PRIMARY_EVENT = {
  name: 'Hurricane Helene',
  category: 'Category 4',
  location: 'Gulf Coast, TX',
  windSpeed: '140 mph',
  elapsed: '2h 14m',
  status: 'Active Landfall',
}

// Individual caller reports within the disaster zone
export const MOCK_INCIDENTS = [
  {
    id: 1,
    lat: 29.7604, lng: -95.3698,
    type: 'Rescue', tier: 'Critical', score: 97,
    description: 'Family of 4 trapped on rooftop. Floodwater rising. Children ages 3 and 7 present.',
    address: '1847 Bayou Bend Rd', timeAgo: '2m ago', people: 4, call_count: 3,
    required_responders: { fire: 2, ems: 1, police: 0, rescue: 2 },
  },
  {
    id: 2,
    lat: 29.7721, lng: -95.3812,
    type: 'Medical', tier: 'Critical', score: 94,
    description: 'Cardiac emergency. 70-year-old male collapsed during evacuation. No AED on site.',
    address: '524 Westheimer Rd', timeAgo: '4m ago', people: 1, call_count: 1,
    required_responders: { fire: 0, ems: 2, police: 0, rescue: 0 },
  },
  {
    id: 3,
    lat: 29.7498, lng: -95.3553,
    type: 'Rescue', tier: 'Critical', score: 91,
    description: 'Vehicle submerged beneath overpass. 2 occupants visible, driver unconscious.',
    address: 'I-10 W & Kirkwood Rd', timeAgo: '6m ago', people: 2, call_count: 2,
    required_responders: { fire: 1, ems: 2, police: 1, rescue: 1 },
  },
  {
    id: 4,
    lat: 29.7633, lng: -95.3901,
    type: 'Structural', tier: 'Urgent', score: 76,
    description: 'Apartment building partial roof collapse. Unknown number of residents still inside.',
    address: '3302 Allen Pkwy', timeAgo: '9m ago', people: null, call_count: 4,
    required_responders: { fire: 3, ems: 2, police: 1, rescue: 0 },
  },
  {
    id: 5,
    lat: 29.7550, lng: -95.3620,
    type: 'Medical', tier: 'Urgent', score: 72,
    description: 'Three injured by airborne debris. One with suspected head trauma, two with lacerations.',
    address: '710 Memorial Dr', timeAgo: '7m ago', people: 3, call_count: 2,
    required_responders: { fire: 0, ems: 3, police: 0, rescue: 0 },
  },
  {
    id: 6,
    lat: 29.7680, lng: -95.3740,
    type: 'Rescue', tier: 'Urgent', score: 68,
    description: 'Elderly woman trapped in flooded first-floor apartment. Water at chest level.',
    address: '982 Shepherd Dr', timeAgo: '11m ago', people: 1, call_count: 1,
    required_responders: { fire: 1, ems: 1, police: 0, rescue: 1 },
  },
  {
    id: 7,
    lat: 29.7440, lng: -95.3490,
    type: 'Missing Person', tier: 'Urgent', score: 65,
    description: 'Child (age 6, male) separated from parents at evacuation center.',
    address: 'GRB Convention Center', timeAgo: '13m ago', people: 1, call_count: 1,
    required_responders: { fire: 0, ems: 0, police: 2, rescue: 0 },
  },
  {
    id: 8,
    lat: 29.7710, lng: -95.3590,
    type: 'Evacuation', tier: 'Urgent', score: 61,
    description: 'Family of 5 with two wheelchair-bound members. No vehicle. Cannot self-evacuate.',
    address: '2201 Lamar St', timeAgo: '15m ago', people: 5, call_count: 1,
    required_responders: { fire: 0, ems: 1, police: 1, rescue: 0 },
  },
  {
    id: 9,
    lat: 29.7575, lng: -95.3810,
    type: 'Infrastructure', tier: 'Standard', score: 38,
    description: 'Gas leak detected at storm-damaged commercial building. Residents nearby smell gas.',
    address: '456 Montrose Blvd', timeAgo: '22m ago', people: null, call_count: 2,
    required_responders: { fire: 2, ems: 0, police: 1, rescue: 0 },
  },
  {
    id: 10,
    lat: 29.7650, lng: -95.3455,
    type: 'Evacuation', tier: 'Standard', score: 32,
    description: 'Neighborhood shelter at full capacity. 45 residents awaiting redirect to overflow site.',
    address: 'Emancipation Park Shelter', timeAgo: '30m ago', people: 45, call_count: 1,
    required_responders: { fire: 0, ems: 1, police: 2, rescue: 0 },
  },
]

export const TIER_COLORS = {
  Critical: '#F43F5E',
  Urgent: '#F97316',
  Standard: '#FBBF24',
}

export const TIER_RGB = {
  Critical: [244, 63, 94],
  Urgent: [249, 115, 22],
  Standard: [251, 191, 36],
}
